#!/usr/bin/env bash
# deploy.sh で作ったリソースを削除する
set -uo pipefail
export MSYS_NO_PATHCONV=1
: "${AWS_PROFILE:?AWS_PROFILE を指定する}"
NAME=nagi-vault-phase0-apigw
for id in $(aws apigatewayv2 get-apis --query "Items[?Name=='$NAME'].ApiId" --output text); do aws apigatewayv2 delete-api --api-id "$id" && echo "deleted api $id"; done
aws lambda delete-function --function-name "$NAME" && echo "deleted function"
aws iam detach-role-policy --role-name "$NAME" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role --role-name "$NAME" && echo "deleted role"
aws logs delete-log-group --log-group-name "/aws/lambda/$NAME" && echo "deleted log group"
