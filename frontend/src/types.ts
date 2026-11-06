// What the SCREEN uses. The server's own shape lives only in api/adapter.ts.
export interface Todo {
  id: number;
  title: string;
  completed: boolean;
  createdAt: Date;
}

export type Filter = "all" | "active" | "completed";
