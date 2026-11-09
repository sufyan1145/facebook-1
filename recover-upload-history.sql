-- RECOVER UPLOAD HISTORY after a Facebook disconnect/reconnect made old videos upload again.
-- Run in the DATABASE container's terminal:   psql -U <db user> -d <db name>
-- NOT TESTED on your database: run STEP 1 and 2 first (they only read), check the result, then STEP 3 per Page.
-- 0) First pause the schedules in the app and cancel waiting jobs on the Queue page.

-- STEP 1: history that belongs to Page rows which no longer exist (the OLD page uuid)
SELECT uh.facebook_page_id AS old_page_uuid, COUNT(*) AS videos,
       MIN(uh.video_name) AS example_video, MIN(uh.drive_folder_name) AS drive_folder, MAX(uh.uploaded_at) AS last_upload
FROM upload_history uh
WHERE uh.status = 'success' AND uh.facebook_page_id IS NOT NULL
  AND uh.facebook_page_id NOT IN (SELECT id::text FROM pages)
GROUP BY uh.facebook_page_id
ORDER BY last_upload DESC;

-- STEP 2: which CURRENT Page each old uuid most likely belongs to (matched through your Activity Logs)
SELECT uh.facebook_page_id AS old_page_uuid, p.id AS new_page_uuid, p.page_name, COUNT(DISTINCT uh.id) AS rows_matched
FROM upload_history uh
JOIN logs l ON l.user_id = uh.user_id AND l.action = 'Video Uploaded' AND (l.details::jsonb)->>'file' = uh.video_name
JOIN pages p ON p.user_id = uh.user_id AND p.page_name = (l.details::jsonb)->>'page'
WHERE uh.facebook_page_id NOT IN (SELECT id::text FROM pages)
GROUP BY uh.facebook_page_id, p.id, p.page_name
ORDER BY uh.facebook_page_id, rows_matched DESC;

-- STEP 3 (once per Page): put the OLD history on the NEW Page row.
-- Replace OLD_UUID and NEW_UUID with the values from steps 1-2.
-- (a) optional: see which videos were wrongly uploaded AGAIN (delete these duplicate posts on Facebook yourself)
--   SELECT n.video_name, n.facebook_video_id, n.uploaded_at
--   FROM upload_history n JOIN upload_history o ON o.drive_file_id = n.drive_file_id
--   WHERE n.facebook_page_id = 'NEW_UUID' AND o.facebook_page_id = 'OLD_UUID';
BEGIN;
DELETE FROM upload_history n
USING upload_history o
WHERE n.facebook_page_id = 'NEW_UUID' AND o.facebook_page_id = 'OLD_UUID' AND n.drive_file_id = o.drive_file_id;
UPDATE upload_history SET facebook_page_id = 'NEW_UUID' WHERE facebook_page_id = 'OLD_UUID';
COMMIT;   -- type ROLLBACK; instead if anything looks wrong
