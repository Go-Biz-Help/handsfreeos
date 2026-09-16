// Images imported from ../assets: Metro hands back an asset the Image component takes.
declare module '*.png' {
  import type { ImageSourcePropType } from 'react-native';

  const source: ImageSourcePropType;
  export default source;
}
