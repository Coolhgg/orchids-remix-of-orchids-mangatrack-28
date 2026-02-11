import { prisma } from '@/lib/prisma';

async function test() {
  try {
    const start = Date.now();
    const user = await prisma.user.findUnique({
      where: { id: '8c56e2b0-1fb6-48c6-9952-c3bc9e75fbfc' },
      select: { id: true, username: true, safe_browsing_mode: true }
    });
    const latency = Date.now() - start;
    console.log('SUCCESS:', JSON.stringify({ user, latency }));
  } catch (error: any) {
    console.log('ERROR:', JSON.stringify({ 
      message: error.message?.slice(0, 300), 
      code: error.code, 
      name: error.name 
    }));
  }
}

test();
