#!/usr/bin/env node
// CDK アプリの入口。アカウント ID やメールアドレスはリポジトリに書かず、実行時に渡す。
import { createHash } from 'node:crypto';
import { App, Tags } from 'aws-cdk-lib';
import { NagiVaultStack } from '../lib/nagi-vault-stack.js';

const app = new App();
const envName = (app.node.tryGetContext('env') as string | undefined) ?? 'dev';
const account = process.env['CDK_DEFAULT_ACCOUNT'];
const region = process.env['CDK_DEFAULT_REGION'];
if (!account || !region) throw new Error('AWS の認証情報とリージョンを設定してください（例: AWS_PROFILE=nagi-vault）');

// 費用通知の送り先（必須）。例: NAGI_VAULT_BUDGET_EMAIL=you@example.com npx cdk deploy
const budgetEmail = process.env['NAGI_VAULT_BUDGET_EMAIL'] ?? (app.node.tryGetContext('budgetEmail') as string | undefined);
if (!budgetEmail) throw new Error('環境変数 NAGI_VAULT_BUDGET_EMAIL に費用通知の送り先を指定してください');

// Cognito のドメイン接頭辞はリージョン内で一意にする必要がある。アカウント ID を直接出さないようハッシュを使う
const suffix = createHash('sha256').update(`${account}:${region}`).digest('hex').slice(0, 8);
const cognitoDomainPrefix = (app.node.tryGetContext('cognitoDomainPrefix') as string | undefined) ?? `nagi-vault-${envName}-${suffix}`;

const vaultBucketName = (app.node.tryGetContext('vaultBucketName') as string | undefined) ?? `nagi-vault-${envName}-vault-${suffix}`;

const stack = new NagiVaultStack(app, `NagiVault-${envName}`, {
  env: { account, region },
  envName,
  vaultBucketName,
  cognitoDomainPrefix,
  budgetEmail,
});
Tags.of(stack).add('Project', 'nagi-vault');
Tags.of(stack).add('Environment', envName);
