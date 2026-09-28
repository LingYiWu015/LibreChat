import { memo } from 'react';
import { Folder } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useProjectQuery } from '~/data-provider';
import { useLocalize } from '~/hooks';

function ProjectBadge({ projectId }: { projectId: string }) {
  const localize = useLocalize();
  const { data: project } = useProjectQuery(projectId);
  const name = project?.name ?? localize('com_ui_project');

  return (
    <div className="pointer-events-none absolute inset-x-0 top-12 z-[5] flex justify-center px-3 md:top-14">
      <Link
        to={`/projects/${encodeURIComponent(projectId)}`}
        className="pointer-events-auto inline-flex max-w-full items-center gap-1.5 rounded-full border border-border-light bg-surface-secondary px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-primary"
        aria-label={localize('com_ui_project_open_workspace', { name })}
      >
        <Folder className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{name}</span>
      </Link>
    </div>
  );
}

export default memo(ProjectBadge);
