-- 045_brand_colour_violet.sql
-- New Tutipays brand: switch the platform primary colour from the old indigo
-- to violet #7C3AED (pairs with the #C026D3 magenta gradient in the CSS).
-- Only updates installs still on the old default, so a custom admin colour is
-- preserved.
UPDATE site_settings
   SET value = '#7C3AED'
 WHERE key = 'primary_color'
   AND (value IS NULL OR value = '' OR value = '#3b39e4');
