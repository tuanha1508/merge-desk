# GitHub webhook — what you still need to do

The code for `/api/github/webhook` is in [PR #1](https://github.com/tuanha1508/merge-desk/pull/1).  
GitHub is already sending events to `https://merge-desk.vercel.app/api/github/webhook`.  
Deliveries fail with **401** until the steps below are done.

Do these **in order**.

---

## 1. Add the secret in Vercel

1. Open the Vercel project **merge-desk** → **Settings** → **Environment Variables**
2. Add:

| Name | Value |
|------|--------|
| `GITHUB_WEBHOOK_SECRET` | `6612955272e0d3469ba35e088dd081de613e1c61debdd098ee3bebe42c587cd1` |

3. Scope: **Production** (add Preview too if you test preview URLs)
4. Save

This must match the **Secret** field on the GitHub webhook. Do not change one without the other.

---

## 2. Get the webhook code live

1. Merge [PR #1](https://github.com/tuanha1508/merge-desk/pull/1) into `main`  
   (or cherry-pick / deploy that branch)
2. Wait for Vercel to finish deploying from `main`
3. If you only added the env var and code was already on `main`, click **Redeploy** so the running app picks up `GITHUB_WEBHOOK_SECRET`

After deploy, confirm the route exists: production build should include `/api/github/webhook`.

---

## 3. Redeliver in GitHub

1. Open the webhook on the org/repo (the one pointing at `https://merge-desk.vercel.app/api/github/webhook`)
2. Go to **Recent Deliveries**
3. Open a failed delivery → **Redeliver**
4. Expect **HTTP 200**

If you still see **401**: secret mismatch or env not loaded (redeploy again).  
If you see **503**: `GITHUB_WEBHOOK_SECRET` is missing on that environment.  
If you see **404**: the new route is not on the deployed commit yet.

---

## Already done (you can skip)

- [x] Webhook URL: `https://merge-desk.vercel.app/api/github/webhook`
- [x] Content type: `application/json`
- [x] Events: **Pull requests**, **Check runs**, **Pull request review threads**
- [x] SSL verification: enabled
- [x] Secret generated (same string as above)
- [x] Receiver code: verifies signature, exempt from login cookie, allowlists `GITHUB_REPOS`

---

## After deliveries are green

- Open a test PR → GitHub delivery should be **200**
- Queue still uses polling / cache invalidation for freshness until a later realtime layer; merge still goes through the existing GitHub API (`GITHUB_TOKEN`), not the webhook

---

## Security note

The secret in this file is also in chat history. Prefer rotating it after setup:

1. Generate a new one: `openssl rand -hex 32`
2. Update Vercel `GITHUB_WEBHOOK_SECRET`
3. Update the GitHub webhook **Secret**
4. Redeploy, then Redeliver
