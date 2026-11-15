#!/usr/bin/env bash
# Phase 0 検証用の Lambda + HTTP API を一時的に作る。終わったら teardown.sh で削除する。
# 実行前に利用者の確認を取ること（AWS にリソースを作る）。
set -euo pipefail
export MSYS_NO_PATHCONV=1  # Git Bash で /aws/lambda/... がパス変換されるのを防ぐ
cd "$(dirname "$0")"
: "${AWS_PROFILE:?AWS_PROFILE を指定する}"
NAME=nagi-vault-phase0-apigw
RUNTIME="${RUNTIME:-nodejs24.x}"
ROLE_ARN=$(aws iam get-role --role-name "$NAME" --query Role.Arn --output text 2>/dev/null || aws iam create-role --role-name "$NAME" --query Role.Arn --output text \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}')
aws iam attach-role-policy --role-name "$NAME" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws logs create-log-group --log-group-name "/aws/lambda/$NAME" 2>/dev/null || true
aws logs put-retention-policy --log-group-name "/aws/lambda/$NAME" --retention-in-days 1
python -c "import zipfile;z=zipfile.ZipFile('handler.zip','w',zipfile.ZIP_DEFLATED);z.write('handler.mjs');z.close()"
sleep 10 # IAM ロールの反映待ち
FN_ARN=$(aws lambda create-function --function-name "$NAME" --runtime "$RUNTIME" --architectures arm64 \
  --memory-size 256 --timeout 15 --handler handler.handler --role "$ROLE_ARN" \
  --zip-file fileb://handler.zip --query FunctionArn --output text)
aws lambda wait function-active-v2 --function-name "$NAME"
read -r API_ID API_URL < <(aws apigatewayv2 create-api --name "$NAME" --protocol-type HTTP --target "$FN_ARN" \
  --query '[ApiId,ApiEndpoint]' --output text)
aws lambda add-permission --function-name "$NAME" --statement-id apigw --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com --source-arn "$(echo "$FN_ARN" | cut -d: -f1-5 | sed 's/:lambda:/:execute-api:/'):$API_ID/*" >/dev/null
rm -f handler.zip
echo "API_ID=$API_ID"
echo "API_URL=$API_URL"
