-- C296: the memory engine this deployment last booted with ('gbrain' or 'none'). When an engine first arrives
-- (e.g. an install that ran without one switches to GBrain), every document is re-projected (afterRestore path).
CREATE TABLE kn_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
