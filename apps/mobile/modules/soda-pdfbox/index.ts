import { requireNativeModule } from "expo-modules-core";

type SodaPdfBoxModule = {
  extractText(uri: string): Promise<string>;
};

export default requireNativeModule<SodaPdfBoxModule>("SodaPdfBox");
