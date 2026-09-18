-- Шаг последнего принятого кода TOTP: повтор кода в том же окне отклоняется
ALTER TABLE "mfa_factors" ADD COLUMN IF NOT EXISTS "last_step" bigint;
