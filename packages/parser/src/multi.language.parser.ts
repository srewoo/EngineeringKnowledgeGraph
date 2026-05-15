/**
 * Multi-language parser — lightweight regex-based extractor for non-TS source.
 *
 * Supports Java/Kotlin/Scala, Go, Python, Rust, Ruby, PHP, C#.
 * Extracts:
 *   - imports (package/module/use statements)
 *   - DB SDK usage (matched against DATABASE_SDK_MAP)
 *   - HTTP client usage (matched against HTTP_CLIENT_PACKAGES)
 *   - API route registrations (decorator/annotation/macro patterns)
 *   - HTTP outbound calls (URL + method)
 *   - environment variable references
 *
 * Trade-off: regex is less accurate than a real AST per language, but
 * a multi-language AST stack would be 10× the runtime cost. For graph
 * relationships (who-uses-what), regex is sufficient.
 */

import { readFile } from 'node:fs/promises';
import {
  DATABASE_SDK_MAP,
  HTTP_CLIENT_PACKAGES,
  API_FRAMEWORK_PACKAGES,
  createLogger,
} from '@ekg/shared';
import type {
  Logger,
  ParseResult,
  ParsedImport,
  ParsedRoute,
  ParsedHttpCall,
  ParsedDatabaseUsage,
} from '@ekg/shared';

export type SupportedLanguage =
  | 'java' | 'kotlin' | 'scala'
  | 'go'
  | 'python'
  | 'rust'
  | 'ruby' | 'php' | 'csharp'
  | 'c' | 'cpp';

const EXT_TO_LANG: Readonly<Record<string, SupportedLanguage>> = {
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala',
  '.go': 'go',
  '.py': 'python', '.pyi': 'python',
  '.rs': 'rust',
  '.rb': 'ruby', '.php': 'php', '.cs': 'csharp',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
};

export class MultiLanguageParser {
  private readonly logger: Logger;

  constructor() {
    this.logger = createLogger({ service: 'multi-language-parser' });
  }

  /** True if this parser handles the given file extension. */
  static handles(extension: string): boolean {
    return extension.toLowerCase() in EXT_TO_LANG;
  }

  static detectLanguage(extension: string): SupportedLanguage | undefined {
    return EXT_TO_LANG[extension.toLowerCase()];
  }

  /**
   * Parse a single file. Returns an empty ParseResult on failure or unsupported language.
   */
  async parseFile(filePath: string): Promise<ParseResult> {
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    const lang = EXT_TO_LANG[ext];
    if (!lang) return this.empty(filePath);

    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch (error) {
      this.logger.warn({ filePath, error }, 'Failed to read file');
      return this.empty(filePath);
    }

    const imports = this.extractImports(content, lang);
    const routes = this.extractRoutes(content, lang);
    const httpCalls = this.extractHttpCalls(content, lang);
    const databaseUsages = this.extractDatabaseUsages(imports);
    const envVars = this.extractEnvVars(content, lang);

    return {
      filePath,
      imports,
      exports: [],
      routes,
      httpCalls,
      databaseUsages,
      envVars,
      loc: countLines(content),
    };
  }

  // -- Imports -----------------------------------------------------------------

  private extractImports(src: string, lang: SupportedLanguage): readonly ParsedImport[] {
    const out: ParsedImport[] = [];
    const patterns = IMPORT_PATTERNS[lang] ?? [];
    for (const re of patterns) {
      const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
      let m: RegExpExecArray | null;
      while ((m = r.exec(src)) !== null) {
        const source = (m[1] ?? '').trim();
        if (!source) continue;
        out.push({
          source,
          specifiers: [],
          isTypeOnly: false,
          isLocal: this.isLocalImport(source, lang),
        });
      }
    }
    // Dedupe by source
    const seen = new Set<string>();
    return out.filter((i) => {
      if (seen.has(i.source)) return false;
      seen.add(i.source);
      return true;
    });
  }

  private isLocalImport(source: string, lang: SupportedLanguage): boolean {
    if (lang === 'go') {
      // Local Go imports usually share the module path; mark as non-local for now.
      // External: github.com/..., golang.org/...
      return source.startsWith('./') || source.startsWith('../');
    }
    if (lang === 'python') {
      return source.startsWith('.');
    }
    if (lang === 'rust') {
      return source.startsWith('crate::') || source.startsWith('self::') || source.startsWith('super::');
    }
    return source.startsWith('.') || source.startsWith('/');
  }

  // -- Routes (decorators/macros/annotations) ----------------------------------

  private extractRoutes(src: string, lang: SupportedLanguage): readonly ParsedRoute[] {
    const out: ParsedRoute[] = [];
    const framework = this.detectFramework(src, lang);

    for (const re of ROUTE_PATTERNS[lang] ?? []) {
      const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
      let m: RegExpExecArray | null;
      while ((m = r.exec(src)) !== null) {
        const method = (m[1] ?? '').toUpperCase();
        const path = m[2] ?? '';
        if (!path) continue;
        out.push({
          method: method || 'GET',
          path,
          handlerName: 'unknown',
          framework,
        });
      }
    }
    return out;
  }

  private detectFramework(src: string, lang: SupportedLanguage): string {
    for (const pkg of API_FRAMEWORK_PACKAGES) {
      if (src.includes(pkg)) return pkg;
    }
    return lang;
  }

  // -- HTTP outbound calls -----------------------------------------------------

  private extractHttpCalls(src: string, lang: SupportedLanguage): readonly ParsedHttpCall[] {
    const out: ParsedHttpCall[] = [];
    const patterns = HTTP_CALL_PATTERNS[lang] ?? [];
    for (const { re, client } of patterns) {
      const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
      let m: RegExpExecArray | null;
      while ((m = r.exec(src)) !== null) {
        const method = (m[1] ?? 'GET').toUpperCase();
        const url = (m[2] ?? '').trim();
        if (!url || (!url.startsWith('http') && !url.startsWith('/'))) continue;
        out.push({ url, method, clientLibrary: client });
      }
    }
    return out;
  }

  // -- Databases ---------------------------------------------------------------

  private extractDatabaseUsages(
    imports: readonly ParsedImport[],
  ): readonly ParsedDatabaseUsage[] {
    const out: ParsedDatabaseUsage[] = [];
    const seen = new Set<string>();
    for (const imp of imports) {
      // Match exact and prefix (e.g. org.springframework.data.mongodb.repository → MongoDB)
      let dbType: string | undefined;
      if (DATABASE_SDK_MAP[imp.source]) {
        dbType = DATABASE_SDK_MAP[imp.source];
      } else {
        for (const [pkg, type] of Object.entries(DATABASE_SDK_MAP)) {
          if (imp.source.startsWith(pkg)) { dbType = type; break; }
        }
      }
      if (!dbType) continue;
      const key = `${dbType}:${imp.source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        databaseType: dbType,
        detectedVia: 'sdk_import',
        packageName: imp.source,
      });
    }
    return out;
  }

  // -- Env vars ---------------------------------------------------------------

  private extractEnvVars(src: string, lang: SupportedLanguage): readonly string[] {
    const found = new Set<string>();
    const patterns = ENV_PATTERNS[lang] ?? [];
    for (const re of patterns) {
      const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
      let m: RegExpExecArray | null;
      while ((m = r.exec(src)) !== null) {
        const name = m[1];
        if (name && /^[A-Z_][A-Z0-9_]*$/.test(name)) found.add(name);
      }
    }
    return [...found];
  }

  private empty(filePath: string): ParseResult {
    return {
      filePath,
      imports: [],
      exports: [],
      routes: [],
      httpCalls: [],
      databaseUsages: [],
      envVars: [],
    };
  }
}

function countLines(content: string): number {
  if (!content) return 0;
  let n = 1;
  for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) n++;
  return n;
}

// ---- Language-specific regex tables ----------------------------------------

const IMPORT_PATTERNS: Readonly<Record<SupportedLanguage, readonly RegExp[]>> = {
  java: [
    /import\s+(?:static\s+)?([\w.]+)(?:\.\*)?\s*;/g,
  ],
  kotlin: [
    /import\s+([\w.]+)(?:\.\*)?(?:\s+as\s+\w+)?/g,
  ],
  scala: [
    /import\s+([\w.]+)(?:\.[{_].*?)?/g,
  ],
  go: [
    /import\s+"([^"]+)"/g,
    // Inside `import ( ... )` block: capture each quoted path on its own line
    /^\s*(?:[a-zA-Z_]\w*\s+)?"([^"]+)"\s*$/gm,
  ],
  python: [
    /^\s*import\s+([\w.]+)/gm,
    /^\s*from\s+([\w.]+)\s+import\s+/gm,
  ],
  rust: [
    /^\s*use\s+([\w:]+)(?:::\{[^}]*\})?\s*;/gm,
    /extern\s+crate\s+(\w+)\s*;/g,
  ],
  ruby: [
    /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/gm,
  ],
  php: [
    /^\s*use\s+([\w\\]+)\s*;/gm,
    /^\s*(?:require|include)(?:_once)?\s*\(?['"]([^'"]+)['"]/gm,
  ],
  csharp: [
    /^\s*using\s+([\w.]+)\s*;/gm,
  ],
  c: [
    /^\s*#include\s+["<]([^">]+)[">]/gm,
  ],
  cpp: [
    /^\s*#include\s+["<]([^">]+)[">]/gm,
  ],
};

const ROUTE_PATTERNS: Readonly<Record<SupportedLanguage, readonly RegExp[]>> = {
  java: [
    // Spring: @GetMapping("/path"), @RequestMapping(value="/x", method=RequestMethod.POST)
    /@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g,
    /@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["'][^)]*method\s*=\s*RequestMethod\.(\w+)/g,
    // JAX-RS: @Path("/x") @GET
    /@Path\s*\(\s*["']([^"']+)["']/g,
  ],
  kotlin: [
    /@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g,
  ],
  scala: [],
  go: [
    // Gin/Echo/Fiber/Mux: r.GET("/path", handler)
    /\.(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s*\(\s*["']([^"']+)["']/g,
    // net/http: http.HandleFunc("/path", handler)
    /HandleFunc\s*\(\s*["']([^"']+)["']/g,
  ],
  python: [
    // Flask / FastAPI: @app.get("/x"), @router.post("/x")
    /@\w+\.(get|post|put|delete|patch|options|head)\s*\(\s*["']([^"']+)["']/g,
    // Flask: @app.route("/x", methods=["POST"])
    /@\w+\.route\s*\(\s*["']([^"']+)["']/g,
    // Django urls: path("x/", view)
    /\bpath\s*\(\s*["']([^"']+)["']/g,
  ],
  rust: [
    // Actix: #[get("/x")]
    /#\[(get|post|put|delete|patch)\s*\(\s*"([^"]+)"\s*\)\]/g,
    // Axum: .route("/x", get(handler))
    /\.route\s*\(\s*"([^"]+)"\s*,\s*(get|post|put|delete|patch)/g,
  ],
  ruby: [
    // Rails: get "/x", to: "..."
    /^\s*(get|post|put|delete|patch)\s+["']([^"']+)["']/gm,
  ],
  php: [
    // Laravel: Route::get('/x', ...)
    /Route::(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g,
  ],
  csharp: [
    // ASP.NET: [HttpGet("/x")]
    /\[Http(Get|Post|Put|Delete|Patch)\s*\(\s*"([^"]+)"\s*\)\]/g,
  ],
  c: [],
  cpp: [],
};

const HTTP_CALL_PATTERNS: Readonly<Record<SupportedLanguage, readonly { re: RegExp; client: string }[]>> = {
  java: [
    { re: /restTemplate\.\w*For\w*\(\s*["']([^"']+)["']/g, client: 'org.springframework.web.client' },
    { re: /\.newCall\(\s*new\s+Request\.Builder\(\)\.url\(\s*["']([^"']+)["']/g, client: 'okhttp3' },
  ],
  kotlin: [
    { re: /\.newCall\(\s*Request\.Builder\(\)\.url\(\s*["']([^"']+)["']/g, client: 'okhttp3' },
  ],
  scala: [],
  go: [
    { re: /http\.(Get|Post|Put|Delete|Head)\s*\(\s*["']([^"']+)["']/g, client: 'net/http' },
    { re: /\.R\(\)\.\w+\(\s*["']([^"']+)["']/g, client: 'github.com/go-resty/resty' },
  ],
  python: [
    { re: /requests\.(get|post|put|delete|patch|head)\s*\(\s*["']([^"']+)["']/g, client: 'requests' },
    { re: /httpx\.(get|post|put|delete|patch|head)\s*\(\s*["']([^"']+)["']/g, client: 'httpx' },
    { re: /aiohttp\.\w+\.(get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/g, client: 'aiohttp' },
  ],
  rust: [
    { re: /reqwest::Client::new\(\)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*"([^"]+)"/g, client: 'reqwest' },
  ],
  ruby: [
    { re: /Net::HTTP\.(get|post)\s*\(\s*URI\(\s*["']([^"']+)["']/g, client: 'net/http' },
    { re: /HTTParty\.(get|post|put|delete)\s*\(\s*["']([^"']+)["']/g, client: 'httparty' },
  ],
  php: [
    { re: /\$client->(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g, client: 'guzzle' },
  ],
  csharp: [
    { re: /HttpClient\(\)\s*\.\s*(GetAsync|PostAsync|PutAsync|DeleteAsync)\s*\(\s*"([^"]+)"/g, client: 'System.Net.Http' },
  ],
  c: [],
  cpp: [],
};

const ENV_PATTERNS: Readonly<Record<SupportedLanguage, readonly RegExp[]>> = {
  java: [
    /System\.getenv\s*\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g,
    /@Value\s*\(\s*["']\$\{([A-Z_][A-Z0-9_.]*)\}/g,
  ],
  kotlin: [
    /System\.getenv\s*\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g,
  ],
  scala: [
    /sys\.env\s*\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g,
  ],
  go: [
    /os\.Getenv\s*\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g,
    /os\.LookupEnv\s*\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g,
  ],
  python: [
    /os\.environ\s*\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g,
    /os\.environ\.get\s*\(\s*["']([A-Z_][A-Z0-9_]*)["']/g,
    /os\.getenv\s*\(\s*["']([A-Z_][A-Z0-9_]*)["']/g,
  ],
  rust: [
    /std::env::var\s*\(\s*"([A-Z_][A-Z0-9_]*)"\s*\)/g,
    /env!\s*\(\s*"([A-Z_][A-Z0-9_]*)"\s*\)/g,
  ],
  ruby: [
    /ENV\s*\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g,
    /ENV\.fetch\s*\(\s*["']([A-Z_][A-Z0-9_]*)["']/g,
  ],
  php: [
    /getenv\s*\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
    /\$_ENV\s*\[\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  ],
  csharp: [
    /Environment\.GetEnvironmentVariable\s*\(\s*"([A-Z_][A-Z0-9_]*)"\s*\)/g,
  ],
  c: [
    /getenv\s*\(\s*"([A-Z_][A-Z0-9_]*)"\s*\)/g,
  ],
  cpp: [
    /getenv\s*\(\s*"([A-Z_][A-Z0-9_]*)"\s*\)/g,
  ],
};
