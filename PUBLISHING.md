# ShareCapsule Finance Publishing Checklist

This checklist is the release gate for `https://finance.sharecapsule.app`.

## 1. Platform navigation

Verify every public area can reach the major platform destinations without using browser Back:

- `/` — Private Planner
- `/guide/` — Financial Control Guide
- `/passive-income/` — Income Project Lab
- `/about/` — Trust Center
- `/methodology/`
- `/privacy/`
- `/security/`
- `/sources/`
- `/roadmap/`

Verify `404.html` routes users back into the platform.

## 2. Domain and HTTPS

- GitHub Pages custom domain is `finance.sharecapsule.app`.
- Root `CNAME` contains only `finance.sharecapsule.app`.
- HTTPS loads without certificate warnings.
- `http://finance.sharecapsule.app` redirects to HTTPS.
- `sync.finance.sharecapsule.app` resolves only to the encrypted sync relay.

## 3. Search discovery

- `/robots.txt` loads successfully.
- `/sitemap.xml` loads successfully and lists all intended public pages.
- Submit `https://finance.sharecapsule.app/sitemap.xml` in Google Search Console after launch.
- Check titles/descriptions on the planner, guide and Income Project Lab.
- Do not index pages that contain user-specific decrypted data; the planner itself exposes no server-rendered user financial state.

## 4. Privacy release gate

- Local-only remains the default mode.
- No analytics, advertising, remote fonts or third-party scripts are added to the finance planner.
- Browser Network inspection shows no readable financial payload leaving the device.
- The sync relay receives only encrypted vault records and synchronization metadata.
- The vault passphrase is never persisted or transmitted.
- QR pairing contains no plaintext financial data or passphrase.
- Pairing remains one-time and short-lived.
- Privacy and Security pages accurately describe the current implementation.

## 5. Planner functional test

Test on a clean browser profile:

1. Create a new vault.
2. Add income and expense transactions.
3. Add category budgets.
4. Add assets and verify net worth.
5. Add debt and verify APR ordering.
6. Add a savings goal.
7. Verify Planner guidance renders.
8. Lock and unlock the vault.
9. Export an encrypted backup.
10. Restore the encrypted backup in a separate clean browser profile.
11. Verify auto-lock after inactivity.
12. Erase a test vault and verify local state is removed.

## 6. Laptop + mobile sync test

Use two real devices before every significant sync release:

1. Enable sync on device A.
2. Generate a new pairing QR.
3. Scan it on device B.
4. Unlock both devices with the existing vault passphrase.
5. Add a unique transaction on device A and confirm it appears on device B.
6. Add a unique transaction on device B and confirm it appears on device A.
7. Verify local saves push without waiting for a page reload.
8. Verify incoming changes update an already-unlocked UI.
9. Make simultaneous edits and confirm the conflict chooser appears instead of silently overwriting data.
10. Disconnect one device and verify its local encrypted vault remains.
11. Disable sync everywhere in a disposable test vault and confirm both devices stop syncing.

## 7. Sync relay release gate

- Cloudflare Worker is deployed for `sync.finance.sharecapsule.app`.
- Required D1 migrations are applied.
- Unauthorized requests are rejected.
- Expired or reused pairing requests are rejected.
- Revision conflicts return conflict responses rather than overwriting silently.
- Request-size and rate limits are configured appropriately before broader public promotion.
- D1 inspection confirms no plaintext finance JSON is stored.

## 8. Income Project Lab test

- Browse and filter income ideas.
- Start one project.
- Confirm a second active project cannot be started simultaneously.
- Complete milestones and save progress notes.
- Mark the project complete.
- Start a different project.
- Reopen the completed project and add a post-launch result.
- Confirm no credentials or financial account secrets are requested by the workflow.

## 9. Guide and trust review

- Every guide page identifies preparation/editorial review information.
- Official sources and ShareCapsule planning opinions are visually and textually distinct.
- Time-sensitive figures such as tax or retirement limits have an explicit review date.
- `/about/`, `/methodology/`, `/privacy/`, `/security/`, `/sources/`, and `/roadmap/` accurately reflect production behavior.
- Never claim independent CFP, CPA, attorney, insurance or other licensed review unless it actually occurred and the scope is stated.

## 10. Browser/device matrix

Minimum launch validation:

- Windows: current Chrome and Edge
- macOS: current Safari and Chrome
- iPhone/iPad: current Safari
- Android: current Chrome

Check desktop, tablet and narrow mobile layouts, including navigation, forms, QR rendering and long tables.

## 11. Performance and accessibility

- No console errors on initial load or normal planner actions.
- No failed first-party asset requests.
- Keyboard users can reach important navigation and buttons.
- Form fields have visible labels.
- Important status/error messages are understandable without color alone.
- Check layout stability and load performance before major promotion.

## 12. Launch sequence

1. Merge/commit the release candidate to `main`.
2. Wait for GitHub Pages to publish the commit.
3. Hard-refresh a clean desktop and mobile browser and confirm current asset versions.
4. Run the privacy, planner and two-device tests above.
5. Confirm the Worker/D1 sync service is healthy.
6. Verify sitemap, robots and 404 behavior.
7. Submit the sitemap to Search Console.
8. Begin with a small invited beta group and collect issues before a broad public launch.

## Rollback rule

If a release causes vault unlock failures, data-loss risk, sync overwrite behavior, unexpected plaintext network traffic, or a security regression, stop promotion and revert to the last validated release before continuing feature work.
