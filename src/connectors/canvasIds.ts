export type CanvasCourse = {
  id: number;
  name: string;
  workflow_state?: string;
  enrollments?: { type: string; enrollment_state: string }[];
  is_favorite?: boolean;
};

export function announcementItemId(id: number | string): string {
  return `announcement:${id}`;
}

export function assignmentItemId(id: number | string): string {
  return `assignment:${id}`;
}

export function missingItemId(id: number | string): string {
  return `missing:${id}`;
}

/** Prefer graded_at; else score+grade string. */
export function gradeItemId(
  assignmentId: number | string,
  gradedAt: string | null,
  score: number | null,
  grade: string | null,
): string {
  if (gradedAt) return `grade:${assignmentId}:${gradedAt}`;
  return `grade:${assignmentId}:${score ?? 'null'}:${grade ?? 'null'}`;
}

/** Active student enrollments (and favorites that are still available student enrollments). */
export function filterActiveCourses(courses: CanvasCourse[]): CanvasCourse[] {
  return courses.filter((c) => {
    if (c.workflow_state === 'completed' || c.workflow_state === 'deleted') return false;
    const ens = c.enrollments ?? [];
    return ens.some(
      (e) => e.type === 'student' && (e.enrollment_state === 'active' || e.enrollment_state === 'invited'),
    );
  });
}
