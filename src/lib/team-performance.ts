// A simple, explainable rating per person, from the tasks assigned to them.
// Nothing is stored: it's worked out from tasks.assignee, due dates and completion dates.

export interface TaskForRating {
  assignee: string | null;
  status: "todo" | "in_progress" | "review" | "done";
  dueDate: string | null;
  completedAt: Date | null;
}

export interface PersonRating {
  name: string;
  /** Tasks finished in the window. */
  done: number;
  /** Of those, finished on or before their due date (or with no due date). */
  onTime: number;
  /** Open tasks past their due date right now. */
  overdue: number;
  /** Open tasks in total. */
  open: number;
  /** 0–100. */
  score: number;
  label: "Excellent" | "Good" | "Needs focus" | "Behind";
}

export const RATING_WINDOW_DAYS = 30;

export function ratingLabel(score: number): PersonRating["label"] {
  return score >= 85 ? "Excellent" : score >= 70 ? "Good" : score >= 50 ? "Needs focus" : "Behind";
}

/**
 * Score = 70% on-time rate + 30% output (tasks done vs the busiest person), minus 8 points per task overdue now.
 * People with nothing done and nothing open in the window are left out.
 */
export function teamPerformance(tasks: TaskForRating[], today: string, windowDays = RATING_WINDOW_DAYS): PersonRating[] {
  const from = Date.parse(`${today}T00:00:00Z`) - windowDays * 86_400_000;
  const people = new Map<string, Omit<PersonRating, "score" | "label">>();
  for (const t of tasks) {
    const name = t.assignee?.trim();
    if (!name) continue;
    const p = people.get(name) ?? { name, done: 0, onTime: 0, overdue: 0, open: 0 };
    if (t.status === "done") {
      if (t.completedAt && t.completedAt.getTime() >= from) {
        p.done += 1;
        const finished = t.completedAt.toISOString().slice(0, 10);
        if (!t.dueDate || finished <= t.dueDate) p.onTime += 1;
      }
    } else {
      p.open += 1;
      if (t.dueDate && t.dueDate < today) p.overdue += 1;
    }
    people.set(name, p);
  }
  const list = [...people.values()].filter((p) => p.done > 0 || p.open > 0);
  const busiest = Math.max(1, ...list.map((p) => p.done));
  return list
    .map((p) => {
      const onTimeRate = p.done ? p.onTime / p.done : p.overdue ? 0 : 1;
      const score = Math.max(0, Math.min(100, Math.round(100 * (0.7 * onTimeRate + 0.3 * (p.done / busiest)) - 8 * p.overdue)));
      return { ...p, score, label: ratingLabel(score) };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}
