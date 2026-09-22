-- Initial POS schema for D1 (SQLite).
-- Apply with: wrangler d1 migrations apply pos --remote

CREATE TABLE IF NOT EXISTS products (
  id       TEXT PRIMARY KEY,
  name     TEXT    NOT NULL,
  -- Money in integer cents. SQLite has no DECIMAL, and floats lose pennies
  -- once you start summing them.
  price    INTEGER NOT NULL CHECK (price >= 0),
  stock    INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  category TEXT    NOT NULL DEFAULT 'general'
);

CREATE TABLE IF NOT EXISTS sales (
  -- Device-generated UUID. UNIQUE is what makes offline sync retries safe:
  -- a sale that was stored but whose response was lost collides on retry
  -- instead of being counted twice.
  client_ref    TEXT    PRIMARY KEY,
  source        TEXT    NOT NULL DEFAULT 'web',
  total         INTEGER NOT NULL CHECK (total >= 0),   -- cents
  items         TEXT    NOT NULL,                      -- JSON array
  sold_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS sales_sold_at_idx ON sales (sold_at DESC);

-- Seed catalog. Prices in cents.
INSERT OR IGNORE INTO products (id, name, price, stock, category) VALUES
  ('espresso',   'Espresso',         250, 100, 'drinks'),
  ('cappuccino', 'Cappuccino',       375, 100, 'drinks'),
  ('icedlatte',  'Iced Latte',       425,  80, 'drinks'),
  ('croissant',  'Butter Croissant', 295,  40, 'bakery'),
  ('muffin',     'Blueberry Muffin', 310,  35, 'bakery'),
  ('sandwich',   'Cheese Sandwich',  550,  25, 'food'),
  ('vegwrap',    'Veg Wrap',         600,  20, 'food'),
  ('water',      'Still Water',      120, 200, 'drinks');
