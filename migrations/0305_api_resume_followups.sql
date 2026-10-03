-- API, MCP and identity workstream, migration 0305: the day whose board a resume prepares.
--
-- After the owner's `service.resume` the Worker has the daily service prepare the next useful board
-- (apps/worker/src/lanes/daily.ts, `followUpResumes`). That work can run more than once for one resume
-- (after the command, and again from the scheduled sweep until the day has a board), and two runs can
-- overlap. The day is therefore claimed here once per resume, before anything is composed: the first run
-- writes it, every other run reads it, so one resume never prepares boards for two different days,
-- whatever the time of the retry and whatever the owner's timezone has become since.
--
-- Operational bookkeeping only: it holds no content of the owner's and is not part of the portable export.
-- It is removed with the rest of an erased account (every table with a user_id column is).
CREATE TABLE resume_followups (
  user_id           TEXT NOT NULL REFERENCES users(user_id),
  -- The `service.resume` command that ended the pause.
  resume_command_id TEXT NOT NULL,
  -- The day to prepare, as the owner counted days at the moment of the resume.
  local_date        TEXT NOT NULL,
  claimed_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, resume_command_id)
);
