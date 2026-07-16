SET ROLE plus_one_owner;

INSERT INTO operations.currency_metadata (currency_code, display_name, decimal_scale)
VALUES ('IDR', 'Indonesian Rupiah', 2);

RESET ROLE;
