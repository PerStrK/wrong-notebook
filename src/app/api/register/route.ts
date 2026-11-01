import { NextResponse } from "next/server"
import { hash } from "bcryptjs"
import { prisma } from "@/lib/prisma"
import { z } from "zod"
import { tooManyRequests } from "@/lib/api-errors"
import { getAppConfig } from "@/lib/config"
import { getClientIp, registerIpLimiter } from "@/lib/rate-limit"
import { accountNameSchema } from "@/lib/account-name"

const userSchema = z.object({
    // 账号名：2-64 个字符、不含空白；兼容历史邮箱形式的账号
    email: accountNameSchema,
    password: z.string().min(6),
    name: z.string().min(1),
    educationStage: z.string().optional(),
    enrollmentYear: z.number().optional(),
})

export async function POST(req: Request) {
    try {
        // 检查是否允许注册
        const config = getAppConfig();
        if (config.allowRegistration !== true) {
            return NextResponse.json(
                { user: null, message: "Registration is currently disabled" },
                { status: 403 }
            );
        }

        // 同一 IP 每小时提交次数有限，防止批量注册或枚举邮箱
        const ip = getClientIp(req.headers)
        if (ip) {
            const retryAfter = registerIpLimiter.retryAfter(ip)
            if (retryAfter > 0) {
                return tooManyRequests(retryAfter)
            }
            registerIpLimiter.hit(ip)
        }

        const body = await req.json()
        const { email, password, name, educationStage, enrollmentYear } = userSchema.parse(body)

        const existingUser = await prisma.user.findUnique({
            where: { email }
        })

        if (existingUser) {
            return NextResponse.json(
                { user: null, message: "User with this account already exists" },
                { status: 409 }
            )
        }

        const hashedPassword = await hash(password, 10)
        const newUser = await prisma.user.create({
            data: {
                email,
                name,
                password: hashedPassword,
                educationStage,
                enrollmentYear
            }
        })

        const { password: newUserPassword, ...rest } = newUser

        return NextResponse.json(
            { user: rest, message: "User created successfully" },
            { status: 201 }
        )
    } catch {
        return NextResponse.json(
            { user: null, message: "Something went wrong" },
            { status: 500 }
        )
    }
}
