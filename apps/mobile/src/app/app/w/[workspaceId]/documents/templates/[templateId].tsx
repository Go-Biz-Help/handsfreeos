import { useLocalSearchParams } from 'expo-router';

import { TemplateScreen } from '@/documents/templates';

/** One document template and its editor, at the web's own address (/app/w/<business>/documents/templates/<template>). */
export default function TemplateRoute() {
  const { templateId } = useLocalSearchParams<{ templateId: string }>();
  return <TemplateScreen templateId={String(templateId ?? '')} />;
}
