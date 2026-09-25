import logoUrl from '../assets/cloudpunch-logo.png';
import reversedUrl from '../assets/cloudpunch-logo-reversed.png';
import { useTheme } from './theme.js';

/**
 * The CloudPunch logo (docs/brand/). The dark theme uses the reversed
 * logo (navy parts in white), since navy vanishes on a dark background.
 */
export function Logo({ height }: { height: number }): JSX.Element {
  const t = useTheme();
  return (
    <img
      src={t.mode === 'dark' ? reversedUrl : logoUrl}
      alt="CloudPunch"
      height={height}
      style={{ display: 'block' }}
    />
  );
}
