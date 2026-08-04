SET ROLE plus_one_owner;

ALTER TABLE operations.pending_interactions
  ADD COLUMN resolution_decision text CHECK (
    resolution_decision IS NULL OR resolution_decision IN ('approve', 'reject')
  );

RESET ROLE;
