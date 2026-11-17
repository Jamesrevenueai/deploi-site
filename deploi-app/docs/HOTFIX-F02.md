# HOTFIX F-02: anyone can sign up as staff (production)

> **Status 2026-11-08: contained on deploi-prod.** The founder turned sign-up off, ran the audit (nobody used the hole:
> `claimed_role` / `claimed_org` NULL on every row; the third staff profile is `ojae@getdeploi.com`, the COO, kept as staff
> and added to `STAFF_EMAILS`) and applied `docs/hotfix/F02-hotfix.sql`; the step 3 check returned true / true / true.
> **Remaining:** step 4, the one-line app change in PR #17, which ships with the planned release.

**Severity: critical. Live on `deploi-prod` as of 2026-11-05** (checked read-only: email sign-up enabled,
`handle_new_user` reads `raw_user_meta_data`, staff matched by substring).

## What is wrong

- **F-02.** Supabase sign-up lets the person signing up attach any metadata (`signUp({ options: { data } })`).
  - The production trigger `handle_new_user` copies `role` and `agency_id` from that metadata into `profiles`. So a stranger can sign up as `staff` and read every organization, or join any organization.
  - Staff is also matched by substring, so `hello@getdeploi.co` counts as staff.
  - When a profile is missing, the app builds one from the same metadata (`lib/auth.ts`). Users can also edit that metadata after sign-up.
- **F-01.** Any signed-in user can read every early-access application through the `leads` view.
- **F-03.** Anyone can call `staff_email_list()` and get the staff addresses.

## The patch (this branch: `claude/hotfix-f02-signup`, based on production `main`)

| File | Change |
|---|---|
| `supabase/migrations/20261031000001_signup_trust_hotfix.sql` | The trigger trusts only server-set `raw_app_meta_data` and invites; staff is an exact address match. `leads` runs as the caller and is closed to user roles. `staff_email_list()` is closed to everyone but the definer. Changes no rows; idempotent. |
| `lib/auth.ts` (1 line) | The fallback profile is built from `app_metadata`, never `user_metadata`. |
| `docs/hotfix/F02-hotfix.sql` | The same SQL in one transaction, ready to paste into the Supabase SQL editor; records itself in `_migrations`. |
| `supabase/rollback/20261031000001_signup_trust_hotfix.down.sql` | Emergency only: restores the old (vulnerable) trigger if sign-up itself breaks. |
| `tests/security/signup-hotfix.test.ts` | Reproduces each attack against the real trigger and proves it fails. |

Verified locally on production's schema (migrations through 035):
- Without the patch, a sign-up asking for staff became **staff**. With the patch it became **client**.
- Invites and server-set metadata still assign the right organization.
- The full suite passes (304/304), with typecheck, lint and the production build clean.

The full release (PR #16) contains the same statements in migration 042. Re-applying them there is harmless.

## Containment steps (owner), in order

1. **Stop new sign-ups now** (reversible; no deploy needed).
   - Supabase dashboard → project **deploi-prod** → Authentication → Sign In / Providers → **Email** → turn off "Allow new users to sign up" → Save.
   - Invited users can still be added from the dashboard.
2. **Look for anyone who already used the hole.** Supabase → SQL editor, run:
   ```sql
   select p.id, p.email, p.role, p.agency_id, p.created_at,
          u.raw_user_meta_data ->> 'role' as claimed_role, u.raw_user_meta_data ->> 'agency_id' as claimed_org
   from profiles p join auth.users u on u.id = p.id
   where p.role = 'staff' or u.raw_user_meta_data ? 'role' or u.raw_user_meta_data ? 'agency_id'
   order by p.created_at;
   ```
   - Every `staff` row must be an address in `STAFF_EMAILS` (`hello@getdeploi.com`, `omarjames908@gmail.com`, and since 2026-11-08 `ojae@getdeploi.com`).
   - Every non-null `claimed_role` or `claimed_org` is suspicious.
   - For a profile that is not yours: `update profiles set role = 'client', agency_id = null where id = '<id>';`, then delete the user under Authentication → Users.
   - Write the ids down first: the audit log (`audit_log`) shows what each one read.
3. **Apply the database patch.** Supabase → SQL editor → paste the whole of `docs/hotfix/F02-hotfix.sql` → Run. It is one transaction. Then check:
   ```sql
   select position('''raw_user_meta_data''' in pg_get_functiondef('public.handle_new_user'::regproc)) = 0 as fixed_trigger,
          not has_table_privilege('authenticated', 'public.leads', 'select') as leads_closed,
          not has_function_privilege('anon', 'public.staff_email_list()', 'execute') as staff_list_closed;
   ```
   All three must be `true`. The alternative to pasting is `npm run db:migrate:prod` from this branch, with `SUPABASE_DATABASE_URL` set; it applies only this pending migration.
4. **Deploy the one-line app fix.** Merge this branch's PR into `main`. Vercel deploys `deploi-app` to production from `main`. Confirm the production deployment is Ready in Vercel.
5. **Re-enable sign-ups only if you want them**, after steps 3 and 4. Step 1 is reversible at any time.

## Rollback

- **The database patch:** if sign-up itself fails after step 3 (it should not), paste `supabase/rollback/20261031000001_signup_trust_hotfix.down.sql` in the SQL editor, keep sign-ups off (step 1), and re-apply the fix as soon as the failure is understood.
- **The app fix:** revert the merge commit on `main`, or promote the previous production deployment in Vercel.
