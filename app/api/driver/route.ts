import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '../../../lib/prisma'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { telegramUserId, name } = body

    if (!telegramUserId || !name) {
      return NextResponse.json(
        { error: 'telegramUserId and name are required' },
        { status: 400 }
      )
    }

    // Find or create driver
    let driver = await prisma.driver.findUnique({
      where: { telegramUserId: String(telegramUserId) },
      include: { company: true }
    })

    if (!driver) {
      // Create default company if needed
      let company = await prisma.company.findFirst()

      if (!company) {
        company = await prisma.company.create({
          data: { name: 'SafeHaul Default Fleet' }
        })
      }

      driver = await prisma.driver.create({
        data: {
          telegramUserId: String(telegramUserId),
          name,
          companyId: company.id
        },
        include: { company: true }
      })
    }

    return NextResponse.json({ driver })
  } catch (error) {
    console.error('Driver API error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const telegramUserId = searchParams.get('telegramUserId')

    if (!telegramUserId) {
      return NextResponse.json(
        { error: 'telegramUserId is required' },
        { status: 400 }
      )
    }

    const driver = await prisma.driver.findUnique({
      where: { telegramUserId },
      include: { company: true }
    })

    if (!driver) {
      return NextResponse.json(
        { error: 'Driver not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({ driver })
  } catch (error) {
    console.error('Driver API error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}