-- 0066 — let a clawback be reversed.
--
-- 0064 made (agent_id, credit_note_id) unique so a re-run could not claw the
-- same return back twice. That also made it impossible to record the OPPOSITE
-- movement against the same note, and voidCreditNote exists: a return note can
-- be voided after it has already reduced an agent's commission, and nothing
-- gave the money back.
--
-- Widening the key to include the reason keeps the original guard exactly as
-- strong — one 'return' row per note per agent — while leaving room for one
-- 'correction' row that reverses it. Additive, like everything else here: the
-- clawback stays on the statement with its reversal underneath, rather than
-- vanishing as if it had never happened.
-- The CONSTRAINT owns the index, so it has to be dropped first; dropping the
-- index directly is refused with 2BP01.
alter table agent_adjustments drop constraint if exists agent_adjustments_agent_id_credit_note_id_key;
drop index if exists agent_adjustments_agent_id_credit_note_id_key;

create unique index if not exists agent_adjustments_note_reason_idx
  on agent_adjustments (agent_id, credit_note_id, reason) where credit_note_id is not null;
