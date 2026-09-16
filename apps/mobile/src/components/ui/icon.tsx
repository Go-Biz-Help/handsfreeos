import type { LucideIcon, LucideProps } from 'lucide-react-native';
import * as React from 'react';
import { withUniwind } from 'uniwind';

import { TextClassContext } from '@/components/ui/text';
import { cn } from '@/lib/utils';

type IconProps = LucideProps & { as: LucideIcon };

function IconImpl({ as: IconComponent, ...props }: IconProps) {
  return <IconComponent {...props} />;
}

const StyledIcon = withUniwind(IconImpl, {
  size: { fromClassName: 'className', styleProperty: 'width' },
  color: { fromClassName: 'className', styleProperty: 'color' },
});

/**
 * A Lucide icon (the web's icon set) coloured and sized by classes: `<Icon as={Mail} className="size-5 text-text-2" />`.
 * Inside a button it takes the button's text colour. Strokes are 1.5, as on the web.
 */
function Icon({ as: IconComponent, className, strokeWidth = 1.5, ...props }: IconProps) {
  const textClass = React.useContext(TextClassContext);
  return (
    <StyledIcon
      as={IconComponent}
      className={cn('size-5 text-text', textClass, className)}
      strokeWidth={strokeWidth}
      {...props}
    />
  );
}

export { Icon };
export type { IconProps };
