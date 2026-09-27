-- One open wallet code per wallet, enforced by the database.
--
-- createRedemption voids open codes and then mints a new one. Two tabs doing
-- that at the same moment both voided nothing and both inserted, leaving two
-- open codes that could each spend the full balance. With this index the
-- second insert fails (23505) and the app hands back the first tab's code.
--
-- Idempotent: any existing duplicates keep only their newest open row.

update wallet_redemptions r
   set status = 'void'
 where r.status = 'open'
   and exists (
     select 1 from wallet_redemptions o
      where o.account_id = r.account_id
        and o.status = 'open'
        and (o.created_at > r.created_at or (o.created_at = r.created_at and o.id > r.id))
   );

create unique index if not exists wallet_redemptions_one_open
  on wallet_redemptions (account_id)
  where status = 'open';
