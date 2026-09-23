-- Phase 2: item management, images, and keyboard entry codes.
--
-- Additive, like 0002. Nothing is dropped.

-- ---------------------------------------------------------------------------
-- Short numeric code for keyboard entry.
--
-- Separate from `barcode` on purpose: a barcode is a 13-digit EAN that a
-- scanner types and a human never does, while this is a 1-4 digit number the
-- counter memorises for the items it sells all day. Conflating them would mean
-- typing 13 digits for rice.
-- ---------------------------------------------------------------------------
ALTER TABLE products ADD COLUMN code TEXT;

-- R2 object key for the tile image. NULL renders a coloured initial instead, so
-- an item without a photo is still perfectly sellable.
ALTER TABLE products ADD COLUMN image_key TEXT;

-- Both must be unique to be usable as entry keys: two items answering to `12`
-- would make typing `12` ambiguous, and the counter would silently ring up the
-- wrong one. Partial, so the many items with neither are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS products_code_idx
  ON products (code) WHERE code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS products_barcode_unique_idx
  ON products (barcode) WHERE barcode IS NOT NULL;

-- Name search is how items without a code get found, and it runs on every
-- keystroke at the counter.
CREATE INDEX IF NOT EXISTS products_name_idx ON products (name);

-- ---------------------------------------------------------------------------
-- Opening stock needs an equity account.
--
-- Stock a shop already had when it started using this system was not bought
-- today: no money left the till. Posting it against Cash would invent a payment
-- that never happened and leave the cash balance wrong forever. The correct
-- contra is the owner's capital.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO accounts (code, name, type) VALUES
  ('3100', 'Opening Stock Adjustment', 'equity');

-- ---------------------------------------------------------------------------
-- Which bill layout the counter gets by default, so it never has to choose
-- twice. 58mm | 80mm | a4. PDF is an action on any of them, not a layout.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('bill_format', '58mm'),
  -- Printed on the bill beneath the totals. Shops use this for terms, a thank
  -- you, or a returns policy.
  ('bill_footer', ''),
  ('address', ''),
  ('phone', '');

-- Give the seeded demo items codes so keyboard entry is usable immediately
-- rather than only after someone adds their own catalog.
UPDATE products SET code = '1'  WHERE id = 'espresso'   AND code IS NULL;
UPDATE products SET code = '2'  WHERE id = 'cappuccino' AND code IS NULL;
UPDATE products SET code = '3'  WHERE id = 'icedlatte'  AND code IS NULL;
UPDATE products SET code = '4'  WHERE id = 'croissant'  AND code IS NULL;
UPDATE products SET code = '5'  WHERE id = 'muffin'     AND code IS NULL;
UPDATE products SET code = '6'  WHERE id = 'sandwich'   AND code IS NULL;
UPDATE products SET code = '7'  WHERE id = 'vegwrap'    AND code IS NULL;
UPDATE products SET code = '8'  WHERE id = 'water'      AND code IS NULL;
UPDATE products SET code = '9'  WHERE id = 'delivery'   AND code IS NULL;
UPDATE products SET code = '10' WHERE id = 'catering'   AND code IS NULL;
