/**
 * DB 層の入口。呼び出し側は `Repositories` だけに依存し、本番は `createSupabaseRepositories()`、
 * テストとローカル開発は `createMemoryRepositories(seed?, { clock })` を渡す。
 */
export * from './types';
export { createMemoryRepositories } from './memory';
export type { MemoryOptions, MemorySeed, SeedConversation } from './memory';
export { createServiceClient, createSupabaseRepositories } from './supabase';
