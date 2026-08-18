# GitHub webhook

Receiver: `POST /api/github/webhook`  
URL: `https://merge-desk.vercel.app/api/github/webhook`

## Status

- [x] Webhook URL on `Slashy-com/slashyemail` and `Slashy-com/slashy-backend`
- [x] Events: **Pull requests**, **Check runs**, **Pull request review threads**
- [x] Content type `application/json`, SSL verification on
- [x] `GITHUB_WEBHOOK_SECRET` set in Vercel (Production + Preview)
- [x] Same secret set on both GitHub webhook configs
- [x] Secret rotated after it appeared in an earlier checklist (never store the live value in git)
- [x] Receiver verifies `X-Hub-Signature-256`, is exempt from the login cookie, and ignores repos outside `GITHUB_REPOS`

## If deliveries fail

| Status | Meaning |
|--------|---------|
| **401** | Secret mismatch, or production has not redeployed after an env change |
| **503** | `GITHUB_WEBHOOK_SECRET` missing on that Vercel environment |
| **404** | Deploy does not include `/api/github/webhook` yet |

Fix by aligning the Vercel env var with the GitHub webhook **Secret**, redeploying, then **Redeliver** from Recent Deliveries.

## Rotate the secret

```bash
openssl rand -hex 32
```

1. Set `GITHUB_WEBHOOK_SECRET` in Vercel (Production + Preview)
2. Patch the Secret on both repo webhooks
3. Redeploy, then Redeliver a recent delivery → expect **200**

## After deliveries are green

Queue freshness still comes from polling / cache invalidation until a later realtime layer. Merges still go through `GITHUB_TOKEN`, not the webhook.
