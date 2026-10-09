export function WorkspaceNavigation({ active, onNavigate }: {
  active: 'prospects' | 'discovery'; onNavigate: (destination: 'prospects' | 'discovery') => void;
}) {
  return <nav className="workspace-navigation" aria-label="Workspace">
    <button aria-current={active === 'prospects' ? 'page' : undefined} onClick={() => { if (active !== 'prospects') onNavigate('prospects'); }}>Prospects</button>
    <button aria-current={active === 'discovery' ? 'page' : undefined} onClick={() => { if (active !== 'discovery') onNavigate('discovery'); }}>Discovery</button>
  </nav>;
}
