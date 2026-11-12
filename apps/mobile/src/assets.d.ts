// Images imported from ../assets: Metro hands back an asset the Image component takes.
declare module '*.png' {
  import type { ImageSourcePropType } from 'react-native';

  const source: ImageSourcePropType;
  export default source;
}

// Sounds imported from ../assets: Metro hands back an asset id, which expo-audio's players take.
declare module '*.wav' {
  const source: number;
  export default source;
}
