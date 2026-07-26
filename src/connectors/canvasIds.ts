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

/**
 * Active student enrollments (and favorites that are still available student enrollments).
 * When enrollments are missing/empty, keep the course if workflow is not completed/deleted
 * (listCourses already scopes enrollment_state=active).
 */
export function filterActiveCourses(courses: CanvasCourse[]): CanvasCourse[] {
  return courses.filter((c) => {
    if (c.workflow_state === 'completed' || c.workflow_state === 'deleted') return false;
    const ens = c.enrollments;
    if (!ens || ens.length === 0) return true;
    return ens.some(
      (e) => e.type === 'student' && (e.enrollment_state === 'active' || e.enrollment_state === 'invited'),
    );
  });
}
