// kdbxweb はブラウザでは組み込みの DOMParser / XMLSerializer を使う。
// Node 用の @xmldom/xmldom を配信物に含めないため、空の代わりを置く（docs/verification.md 1 章）。
export class DOMParser {
  constructor() {
    throw new Error('@xmldom/xmldom is not available in the browser build');
  }
}
export class XMLSerializer {
  constructor() {
    throw new Error('@xmldom/xmldom is not available in the browser build');
  }
}
export default { DOMParser, XMLSerializer };
