#!/usr/bin/env bash
# Deploy the committed HEAD to CloudPunch on AWS (ADR-0035 §4, ADR-0045).
# The AWS counterpart of scripts/deploy-pilot.sh. NOT used until the
# cutover (docs/ops/aws-cutover.md); the pilot VM stays the live server.
#
#   AWS_PROFILE=cloudpunch-prod scripts/deploy-aws.sh            # deploy HEAD
#   AWS_PROFILE=cloudpunch-prod scripts/deploy-aws.sh --no-migrate
#
# 1. builds the image (infra/aws/Dockerfile) for ARM64 and pushes it,
#    tagged with the commit;
# 2. runs the migrations as a one-off job and stops if they fail;
# 3. points the API service at the new image (a rolling update; ECS rolls
#    back by itself if the new task never becomes healthy).
#
# Needs: docker with buildx, the AWS CLI v2, terraform outputs from
# infra/terraform (run from a checkout where `terraform init` was done).
set -euo pipefail

MIGRATE=1
[ "${1:-}" = "--no-migrate" ] && MIGRATE=0

if [ -n "$(git status --porcelain)" ]; then
  echo "deploy-aws: commit or stash your changes first (deploys HEAD only)" >&2
  exit 1
fi
REV="$(git rev-parse --short HEAD)"

tf() { terraform -chdir=infra/terraform output -raw "$1"; }
REPO="$(tf ecr_repository_url)"
CLUSTER="$(tf ecs_cluster)"
SERVICE="$(tf ecs_service)"
JOB="$(tf job_task_family)"
SUBNETS="$(terraform -chdir=infra/terraform output -json task_subnets | tr -d '[]" ')"
SG="$(tf task_security_group)"
REGION="${AWS_REGION:-ap-south-1}"

echo "deploy-aws: building $REV"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${REPO%%/*}"
docker buildx build --platform linux/arm64 -f infra/aws/Dockerfile \
  --build-arg REVISION="$REV" -t "$REPO:$REV" --push .

# Task definitions with the new image (same settings, new tag).
new_revision() {
  local family="$1"
  aws ecs describe-task-definition --region "$REGION" --task-definition "$family" \
    --query taskDefinition --output json |
    node -e '
      const td = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const image = process.argv[1];
      for (const c of td.containerDefinitions) if (c.name === "api" || c.name === "job") c.image = image;
      for (const k of ["taskDefinitionArn","revision","status","requiresAttributes","compatibilities","registeredAt","registeredBy"]) delete td[k];
      process.stdout.write(JSON.stringify(td));
    ' "$REPO:$REV" > "/tmp/cloudpunch-td-$family.json"
  aws ecs register-task-definition --region "$REGION" \
    --cli-input-json "file:///tmp/cloudpunch-td-$family.json" \
    --query taskDefinition.taskDefinitionArn --output text
}

JOB_TD="$(new_revision "$JOB")"
if [ "$MIGRATE" = 1 ]; then
  echo "deploy-aws: migrating"
  TASK="$(aws ecs run-task --region "$REGION" --cluster "$CLUSTER" --task-definition "$JOB_TD" \
    --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=ENABLED}" \
    --overrides '{"containerOverrides":[{"name":"job","command":["migrate"]}]}' \
    --query 'tasks[0].taskArn' --output text)"
  aws ecs wait tasks-stopped --region "$REGION" --cluster "$CLUSTER" --tasks "$TASK"
  CODE="$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --tasks "$TASK" \
    --query 'tasks[0].containers[0].exitCode' --output text)"
  if [ "$CODE" != "0" ]; then
    echo "deploy-aws: migrations failed (exit $CODE); the service is unchanged. Logs: /cloudpunch/<env>, stream job/" >&2
    exit 1
  fi
fi

API_FAMILY="$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].taskDefinition' --output text | sed 's#.*/##; s#:[0-9]*$##')"
API_TD="$(new_revision "$API_FAMILY")"
echo "deploy-aws: rolling out $REV"
aws ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" \
  --task-definition "$API_TD" --query 'service.serviceName' --output text >/dev/null
aws ecs wait services-stable --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE"
echo "deploy-aws: $REV is live"
