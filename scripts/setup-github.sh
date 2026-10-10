#!/usr/bin/env bash
# One-time GitHub setup for the release pipeline. Safe to re-run.
#
# Creates the staging and production environments (production waits for your
# approval), stores the Cloudflare secrets on both, enables the workflows and
# protects master so it only changes through pull requests that pass CI.
#
# Usage:
#   export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
#   gh auth login            # needs repo and workflow scopes
#   ./scripts/setup-github.sh
set -euo pipefail

REPO=${REPO:-danilobnt2/donext}
BRANCH=${BRANCH:-bootstrap/create-todo}
: "${CLOUDFLARE_API_TOKEN:?export CLOUDFLARE_API_TOKEN first}"
: "${CLOUDFLARE_ACCOUNT_ID:?export CLOUDFLARE_ACCOUNT_ID first}"

reviewer_id=$(gh api user --jq .id)

echo "Environments"
gh api -X PUT "repos/$REPO/environments/staging" --silent --input - <<JSON
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON
gh api -X PUT "repos/$REPO/environments/production" --silent --input - <<JSON
{
  "reviewers": [{"type": "User", "id": $reviewer_id}],
  "prevent_self_review": false,
  "deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}
}
JSON
for env in staging production; do
  existing=$(gh api "repos/$REPO/environments/$env/deployment-branch-policies" \
    --jq '[.branch_policies[].name] | index("master")')
  if [ "$existing" = "null" ]; then
    gh api -X POST "repos/$REPO/environments/$env/deployment-branch-policies" \
      -f name=master -f type=branch --silent
  fi
  gh secret set CLOUDFLARE_API_TOKEN --repo "$REPO" --env "$env" --body "$CLOUDFLARE_API_TOKEN"
  gh secret set CLOUDFLARE_ACCOUNT_ID --repo "$REPO" --env "$env" --body "$CLOUDFLARE_ACCOUNT_ID"
done

echo "Workflows"
# The bootstrap token could not write .github/workflows, so they arrive in workflows-pending.
git fetch origin "$BRANCH"
if git cat-file -e "origin/$BRANCH:.github/workflows-pending" 2>/dev/null; then
  git switch "$BRANCH"
  git pull --ff-only origin "$BRANCH"
  mkdir -p .github/workflows
  git mv .github/workflows-pending/* .github/workflows/
  git commit -m "Enable workflows"
  git push origin "$BRANCH"
fi

echo "Branch protection"
gh api -X PUT "repos/$REPO/branches/master/protection" --silent --input - <<JSON
{
  "required_status_checks": {"strict": false, "contexts": ["check"]},
  "enforce_admins": true,
  "required_pull_request_reviews": {"required_approving_review_count": 0},
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON

echo "Done. Open the pull request, wait for CI, merge, then approve production in the Deploy run."
