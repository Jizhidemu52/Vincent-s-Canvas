"""The only public authoring seed allowed in a 050/051 release package."""
import json
import subprocess

from contract import digest, digest_file, read_json, require

MIGRATIONS = ("050_quick_image_item_extract.sql", "051_new_creative_scenes.sql")
SOURCE_PATH = "server/src/new-creative-recipes.ts"
SEED_PATH = "ops/release/creative-050-051-seed.json"
RECIPE_NAMES = {"virtual-try-on": "虚拟试穿", "sketch-to-photo": "线稿转实拍"}
CONTENT_FIELDS = {"systemPrompt", "fieldTemplate", "modelOverrides", "fallbackPrompt", "outputLanguage", "changeNote"}


def content_hash(value):
    # Same recursive key ordering and UTF-8 encoding as stablePromptJson.
    return digest(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))


def validate_seed(value):
    require(isinstance(value, dict) and set(value) == {"schema", "kind", "source", "recipes"}, "051_SEED_FIELDS_INVALID")
    require(type(value["schema"]) is int and value["schema"] == 1 and value["kind"] == "creative-050-051-defaults", "051_SEED_KIND_INVALID")
    source = value["source"]
    require(isinstance(source, dict) and set(source) == {"path", "sha256"} and source["path"] == SOURCE_PATH
            and isinstance(source["sha256"], str) and len(source["sha256"]) == 64
            and all(c in "0123456789abcdef" for c in source["sha256"]), "051_SEED_SOURCE_INVALID")
    rows = value["recipes"]
    require(isinstance(rows, list) and len(rows) == 2
            and all(isinstance(row, dict) and set(row) == {"key", "name", "content", "contentHash"} for row in rows), "051_TWO_FIXED_RECIPES_REQUIRED")
    require([row["key"] for row in rows] == list(RECIPE_NAMES), "051_TWO_FIXED_RECIPE_KEYS_REQUIRED")
    for row in rows:
        require(row["name"] == RECIPE_NAMES[row["key"]], "051_RECIPE_NAME_INVALID")
        content = row["content"]
        require(isinstance(content, dict) and set(content) == CONTENT_FIELDS, "051_CONTENT_FIELDS_INVALID")
        require(isinstance(content["systemPrompt"], str) and 1 <= len(content["systemPrompt"]) <= 100000
                and content["systemPrompt"] == content["systemPrompt"].strip(), "051_SYSTEM_PROMPT_INVALID")
        require(content["fieldTemplate"] == "" and content["modelOverrides"] == {} and content["fallbackPrompt"] == ""
                and content["outputLanguage"] == "en" and isinstance(content["changeNote"], str)
                and 1 <= len(content["changeNote"]) <= 2000, "051_FIXED_CONTENT_DEFAULTS_REQUIRED")
        require(row["contentHash"] == content_hash(content), "051_RECIPE_CONTENT_HASH_MISMATCH")
    return value


def build_source_seed(root):
    """Only import the two new source defaults; no app env, DB or old seed file."""
    source = root / SOURCE_PATH
    require(source.is_file() and not source.is_symlink(), "051_REGULAR_SOURCE_REQUIRED")
    source_hash = digest_file(source)
    result = subprocess.run(["bun", "--no-env-file", str(root / "ops/release/build-creative-050-051-seed.ts")],
                            cwd=root, capture_output=True, text=True, encoding="utf-8", timeout=60, check=True)
    require(digest_file(source) == source_hash, "051_SOURCE_CHANGED_DURING_EXPORT")
    value = {"schema": 1, "kind": "creative-050-051-defaults",
             "source": {"path": SOURCE_PATH, "sha256": source_hash}, "recipes": json.loads(result.stdout)}
    return validate_seed(value)


def verify_payload(root, manifest):
    names = [row["name"] for row in manifest["migrations"]]
    tail = [name for name in names if name >= "050"]
    require(tail in (list(MIGRATIONS), [*MIGRATIONS, "052_layer_studio.sql"])
            and all(names.count(name) == 1 for name in MIGRATIONS), "FIXED_050_051_MIGRATIONS_REQUIRED")
    for name in MIGRATIONS:
        path = root / "server/src/migrations" / name
        row = next(row for row in manifest["migrations"] if row["name"] == name)
        require(path.is_file() and not path.is_symlink() and digest_file(path) == row["sha256"], "050_051_SQL_MANIFEST_HASH_MISMATCH")
    return validate_seed(read_json(root / SEED_PATH))
