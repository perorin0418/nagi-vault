// nagi-vault のインフラ定義（HANDOFF 3.1 節）
// 月額固定料金のかかるリソースは使わない。追加する場合は事前に相談すること（HANDOFF 6 章）。
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface NagiVaultStackProps extends StackProps {
  /** 環境名（dev など） */
  readonly envName: string;
  /**
   * 保管庫用バケットの名前（全世界で一意）。CSP の connect-src に名前を書くため、自動生成ではなく固定にする
   * （自動生成だと CloudFront → CSP → バケット → CORS → CloudFront の循環参照になる）
   */
  readonly vaultBucketName: string;
  /** Cognito のドメインの接頭辞（リージョン内で一意） */
  readonly cognitoDomainPrefix: string;
  /** 費用通知の送り先。リポジトリには書かず、デプロイ時に渡す */
  readonly budgetEmail: string;
}

export class NagiVaultStack extends Stack {
  constructor(scope: Construct, id: string, props: NagiVaultStackProps) {
    super(scope, id, props);

    // ---------- S3（保管庫） ----------
    const vaultBucket = new s3.Bucket(this, 'VaultBucket', {
      bucketName: props.vaultBucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED, // 中身はブラウザで暗号化済み。SSE-S3 で十分（HANDOFF 2 章）
      enforceSSL: true,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [
        { id: 'expire-noncurrent', noncurrentVersionExpiration: Duration.days(90), expiredObjectDeleteMarker: true },
        { id: 'abort-incomplete-mpu', abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
      // 保管庫のデータは、スタックを消しても残す
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---------- S3（画面配信用） ----------
    const webBucket = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ---------- Cognito ----------
    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false, // 利用者は管理者が作る
      signInAliases: { email: true },
      autoVerify: { email: true },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      featurePlan: cognito.FeaturePlan.ESSENTIALS, // マネージドログインに必要。月間アクティブ利用者 10,000 人までは無料枠
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const cognitoDomain = userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: props.cognitoDomainPrefix },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    const cognitoHost = `${props.cognitoDomainPrefix}.auth.${this.region}.amazoncognito.com`;

    // ---------- Lambda ----------
    const fnLogGroup = new logs.LogGroup(this, 'VaultFnLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const vaultFn = new NodejsFunction(this, 'VaultFn', {
      entry: path.join(ROOT, 'api/src/handler.ts'),
      projectRoot: ROOT,
      depsLockFilePath: path.join(ROOT, 'package-lock.json'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(15),
      logGroup: fnLogGroup,
      environment: { VAULT_BUCKET: vaultBucket.bucketName },
      bundling: {
        format: OutputFormat.ESM,
        minify: true,
        sourceMap: false,
        externalModules: [], // AWS SDK もロックファイルの版を同梱する
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    });
    // vaults/ 以下の読み書きだけを許可する。ListBucket は「未作成」を 403 ではなく 404 で判別するため
    vaultFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject'],
      resources: [vaultBucket.arnForObjects('vaults/*')],
    }));
    vaultFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [vaultBucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': ['vaults/*'] } },
    }));

    // ---------- API Gateway（HTTP API） ----------
    const httpApi = new apigw.HttpApi(this, 'HttpApi', {
      createDefaultStage: false,
      description: 'nagi-vault API',
    });
    new apigw.HttpStage(this, 'DefaultStage', {
      httpApi,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: 5, burstLimit: 10 }, // 少人数向けの低い値
    });

    // ---------- CloudFront ----------
    // 保管庫ファイルはブラウザと S3 の間で署名付き URL を使って直接やり取りする（docs/verification.md 5 章）
    const vaultS3Origin = `https://${props.vaultBucketName}.s3.${this.region}.amazonaws.com`;
    const cspDirectives = [
      "default-src 'self'",
      // hash-wasm（Argon2）が WebAssembly を使うため 'wasm-unsafe-eval' を加える（docs/verification.md）
      "script-src 'self' 'wasm-unsafe-eval'",
      `connect-src 'self' https://${cognitoHost} ${vaultS3Origin}`,
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ];
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: cspDirectives.join('; '), override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
      },
    });

    // API の接続先は execute-api のホスト名。httpApi 本体だけに依存させ、ルートや認可設定との循環を避ける
    const apiHost = Fn.select(2, Fn.split('/', httpApi.apiEndpoint));
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `nagi-vault ${props.envName}`,
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(apiHost, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER, // Authorization を転送する
          responseHeadersPolicy: securityHeaders,
        },
      },
      // errorResponses は設定しない。API の 404/412 を書き換えてしまうため
    });
    const appUrl = `https://${distribution.distributionDomainName}`;

    // 画面のドメインからだけ、保管庫ファイルの取得と条件付き保存を許可する。ETag を画面から読めるようにする
    vaultBucket.addCorsRule({
      allowedOrigins: [appUrl],
      allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT],
      allowedHeaders: ['content-type', 'if-match', 'if-none-match'],
      exposedHeaders: ['ETag'],
      maxAge: 600,
    });

    // ---------- Cognito アプリクライアント（PKCE、シークレットなし） ----------
    const client = userPool.addClient('WebClient', {
      generateSecret: false,
      authFlows: {}, // マネージドログインだけを使う
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [`${appUrl}/`],
        logoutUrls: [`${appUrl}/`],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.hours(12),
    });
    new cognito.CfnManagedLoginBranding(this, 'ManagedLoginBranding', {
      userPoolId: userPool.userPoolId,
      clientId: client.userPoolClientId,
      useCognitoProvidedValues: true,
    }).node.addDependency(cognitoDomain);

    // ---------- API のルート（JWT オーソライザー） ----------
    const authorizer = new HttpUserPoolAuthorizer('CognitoAuthorizer', userPool, { userPoolClients: [client] });
    const integration = new HttpLambdaIntegration('VaultIntegration', vaultFn);
    httpApi.addRoutes({ path: '/api/vault', methods: [apigw.HttpMethod.GET], integration, authorizer });
    httpApi.addRoutes({ path: '/api/vault/upload-url', methods: [apigw.HttpMethod.POST], integration, authorizer });

    // ---------- 画面の配置 ----------
    const webDist = path.join(ROOT, 'web/dist');
    if (!existsSync(path.join(webDist, 'index.html'))) {
      throw new Error('web/dist がありません。先に `npm run build` で画面をビルドしてください。');
    }
    new s3deploy.BucketDeployment(this, 'WebDeployment', {
      destinationBucket: webBucket,
      sources: [
        s3deploy.Source.asset(webDist),
        s3deploy.Source.jsonData('config.json', {
          region: this.region,
          userPoolId: userPool.userPoolId,
          userPoolClientId: client.userPoolClientId,
          cognitoDomain: cognitoHost,
        }),
      ],
      distribution,
      distributionPaths: ['/*'],
      memoryLimit: 256,
      logGroup: new logs.LogGroup(this, 'WebDeploymentLogs', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    // ---------- 費用の監視 ----------
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `nagi-vault-${props.envName}-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: 1, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        {
          notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' },
          subscribers: [{ subscriptionType: 'EMAIL', address: props.budgetEmail }],
        },
      ],
    });

    // ---------- 出力 ----------
    new CfnOutput(this, 'AppUrl', { value: `${appUrl}/` });
    new CfnOutput(this, 'WebBucketName', { value: webBucket.bucketName });
    new CfnOutput(this, 'VaultBucketName', { value: vaultBucket.bucketName });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId });
    new CfnOutput(this, 'CognitoDomain', { value: cognitoHost });
  }
}
