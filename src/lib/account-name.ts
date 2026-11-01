import { z } from "zod";

/**
 * 账号名规则：账号不再要求邮箱格式。
 * 2-64 个字符、不含空白即可；历史邮箱形式的账号（如 admin@localhost）仍然合法。
 */
export const ACCOUNT_NAME_REGEX = /^\S{2,64}$/;

export const accountNameSchema = z
    .string()
    .trim()
    .regex(ACCOUNT_NAME_REGEX, "Invalid account name");

export function isValidAccountName(value: string): boolean {
    return ACCOUNT_NAME_REGEX.test(value.trim());
}
