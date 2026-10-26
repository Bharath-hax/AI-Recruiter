import { eq } from 'drizzle-orm';
import { db, ensureDatabaseReady } from './index.ts';
import { users } from './schema.ts';

export async function getOrCreateUser(
  uid: string,
  email: string,
  displayName?: string | null
) {
  try {
    await ensureDatabaseReady();
    const defaultTz = process.env.DEFAULT_TIMEZONE?.trim() || 'UTC';
    const result = await db
      .insert(users)
      .values({
        uid,
        email,
        displayName: displayName ?? email.split('@')[0],
        role: 'manager',
        timezone: defaultTz,
        defaultDeadlineDays: 2,
        autoGenerateTasks: true,
      })
      .onConflictDoUpdate({
        target: users.uid,
        set: {
          email,
          displayName: displayName ?? email.split('@')[0],
          updatedAt: new Date(),
        },
      })
      .returning();

    return result[0];
  } catch (error) {
    console.error('Database user upsert failed:', error);
    throw new Error('Failed to synchronize manager account. Please try again later.', {
      cause: error,
    });
  }
}

export async function updateManagerSettings(
  uid: string,
  updates: {
    timezone?: string;
    defaultDeadlineDays?: number;
    autoGenerateTasks?: boolean;
  }
) {
  try {
    await ensureDatabaseReady();
    const [updated] = await db
      .update(users)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(users.uid, uid))
      .returning();
    return updated ?? null;
  } catch (error) {
    console.error('Database manager settings update failed:', error);
    throw new Error('Failed to save manager automation settings.', {
      cause: error,
    });
  }
}
