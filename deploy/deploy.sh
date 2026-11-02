#!/bin/sh
# Deploys PR review for humans to a k3s cluster: Postgres, the nightly backups, then the app.
# It builds the image locally, imports it into the node's containerd over SSH (no registry),
# makes the secrets once, on the cluster, and rolls the app. Run from the repository root:
#
#   NODE=root@<k3s node> ./deploy/deploy.sh             # Postgres, backups and the app
#   NODE=root@<k3s node> ./deploy/deploy.sh --ingress   # also route pr.chrisjowen.net to it
#
# With OPENROUTER_API_KEY in the environment, it is put in the app's secret (the free allowance).
# Secret values only ever travel through pipes, never on a command line.
set -eu
: "${NODE:?Set NODE to the k3s node to import the image into, e.g. root@host}"
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/hostinger-k3s.yaml}"
NS=pr-review
TAG="v1-$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD)"
k() { kubectl -n "$NS" "$@"; }
patch_secret() { k patch secret "$1" --type merge --patch-file /dev/stdin; }

kubectl apply -f deploy/k8s/postgres.yaml

if ! k get secret pr-review-db >/dev/null 2>&1; then
	printf '{"apiVersion":"v1","kind":"Secret","metadata":{"name":"pr-review-db","namespace":"%s"},"stringData":{"password":"%s"}}' \
		"$NS" "$(openssl rand -hex 24)" | kubectl apply -f -
fi
if ! k get secret pr-review-app >/dev/null 2>&1; then
	pw="$(k get secret pr-review-db -o jsonpath='{.data.password}' | base64 -d)"
	printf '{"apiVersion":"v1","kind":"Secret","metadata":{"name":"pr-review-app","namespace":"%s"},"stringData":{"DATABASE_URL":"postgres://prreview:%s@postgres:5432/prreview","PRREVIEW_SESSION_SECRET":"%s","PRREVIEW_SEAL_KEY":"%s"}}' \
		"$NS" "$pw" "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" | kubectl apply -f -
	unset pw
fi
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
	printf '{"stringData":{"OPENROUTER_API_KEY":"%s"}}' "$OPENROUTER_API_KEY" | patch_secret pr-review-app
fi

kubectl apply -f deploy/k8s/backup.yaml
k rollout status statefulset/postgres --timeout=180s

docker buildx build --platform linux/amd64 -f deploy/Dockerfile -t "pr-review-app:$TAG" --load .
docker save "pr-review-app:$TAG" | ssh "$NODE" k3s ctr images import -
sed "s/IMAGE_TAG/$TAG/" deploy/k8s/app.yaml | kubectl apply -f -
k rollout status deploy/web --timeout=180s

if [ "${1:-}" = "--ingress" ]; then
	kubectl apply -f deploy/k8s/ingress.yaml
fi
echo "deployed pr-review-app:$TAG"
