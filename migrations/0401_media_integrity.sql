-- Visual wardrobe: integrity rules enforced by the database as well as by the commands.
-- (SQLite cannot add a CHECK to an existing table, so these are triggers on the 0400 tables.)
--
--   1. An outfit preview's SVG scene, like its PNG, lives inside its owner's prefix.
--   2. A demo placeholder is only ever attached to a synthetic fixture garment, never to a real one.
--   3. Every image record says where it came from: source_json is a JSON object with a kind.

CREATE TRIGGER outfit_composites_svg_key_owner_insert
BEFORE INSERT ON outfit_composites
FOR EACH ROW WHEN NEW.svg_key IS NOT NULL AND substr(NEW.svg_key, 1, length(NEW.user_id) + 3) != 'u/' || NEW.user_id || '/'
BEGIN
  SELECT RAISE(ABORT, 'outfit_composites.svg_key must be inside the owner prefix');
END;

CREATE TRIGGER outfit_composites_svg_key_owner_update
BEFORE UPDATE OF svg_key ON outfit_composites
FOR EACH ROW WHEN NEW.svg_key IS NOT NULL AND substr(NEW.svg_key, 1, length(NEW.user_id) + 3) != 'u/' || NEW.user_id || '/'
BEGIN
  SELECT RAISE(ABORT, 'outfit_composites.svg_key must be inside the owner prefix');
END;

CREATE TRIGGER media_assets_demo_only_on_synthetic_insert
BEFORE INSERT ON media_assets
FOR EACH ROW WHEN NEW.is_demo = 1 AND NEW.garment_id IS NOT NULL
  AND COALESCE((SELECT g.is_synthetic FROM garments g WHERE g.user_id = NEW.user_id AND g.garment_id = NEW.garment_id), 0) != 1
BEGIN
  SELECT RAISE(ABORT, 'a demo placeholder can only be attached to a synthetic fixture garment');
END;

CREATE TRIGGER media_assets_demo_only_on_synthetic_update
BEFORE UPDATE OF is_demo, garment_id ON media_assets
FOR EACH ROW WHEN NEW.is_demo = 1 AND NEW.garment_id IS NOT NULL
  AND COALESCE((SELECT g.is_synthetic FROM garments g WHERE g.user_id = NEW.user_id AND g.garment_id = NEW.garment_id), 0) != 1
BEGIN
  SELECT RAISE(ABORT, 'a demo placeholder can only be attached to a synthetic fixture garment');
END;

CREATE TRIGGER media_assets_source_required_insert
BEFORE INSERT ON media_assets
FOR EACH ROW WHEN NOT json_valid(NEW.source_json) OR json_type(NEW.source_json) != 'object' OR json_extract(NEW.source_json, '$.kind') IS NULL
BEGIN
  SELECT RAISE(ABORT, 'media_assets.source_json must say where the image came from');
END;

CREATE TRIGGER media_assets_source_required_update
BEFORE UPDATE OF source_json ON media_assets
FOR EACH ROW WHEN NOT json_valid(NEW.source_json) OR json_type(NEW.source_json) != 'object' OR json_extract(NEW.source_json, '$.kind') IS NULL
BEGIN
  SELECT RAISE(ABORT, 'media_assets.source_json must say where the image came from');
END;
