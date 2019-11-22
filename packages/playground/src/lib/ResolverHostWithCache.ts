import { Bundler } from '@velcro/bundler';
import { Resolver, AbstractResolverHost, ResolverHost } from '@velcro/resolver';
import { openDB, IDBPDatabase } from 'idb';
import { timeout, Limiter } from 'ts-primitives';
import { TimeoutError } from './error';

type ThenArg<T> = T extends Promise<infer U> ? U : T;

export class ResolverHostWithCache extends AbstractResolverHost {
  private idbPromise: Promise<IDBPDatabase<unknown> | null>;

  private readonly hostTimeout: number;
  private readonly idbTimeout: number;
  private readonly namespace: string;
  private readonly limiter: Limiter<unknown>;

  private readonly inflightGetCanonicalUrl = new Map<string, ReturnType<ResolverHost['getCanonicalUrl']>>();
  private readonly inflightGetResolveRoot = new Map<string, ReturnType<ResolverHost['getResolveRoot']>>();
  private readonly inflightListEntries = new Map<string, ReturnType<ResolverHost['listEntries']>>();
  private readonly inflightReadFileContent = new Map<string, ReturnType<ResolverHost['readFileContent']>>();

  private readonly getCanonicalUrlCache = new Map<string, ThenArg<ReturnType<ResolverHost['getCanonicalUrl']>>>();
  private readonly getResolveRootCache = new Map<string, ThenArg<ReturnType<ResolverHost['getResolveRoot']>>>();
  private readonly listEntriesCache = new Map<string, ThenArg<ReturnType<ResolverHost['listEntries']>>>();
  private readonly readFileContentCache = new Map<string, ThenArg<ReturnType<ResolverHost['readFileContent']>>>();

  constructor(
    readonly host: ResolverHost,
    { idbTimeout = 5000, hostConcurrency = 8, hostTimeout = 10000, namespace = 'default' } = {}
  ) {
    super();

    this.hostTimeout = hostTimeout;
    this.idbTimeout = idbTimeout;
    this.namespace = namespace;
    this.limiter = new Limiter(hostConcurrency);

    this.idbPromise = openDB(`velcro:rhwc:${this.namespace}`, Bundler.schemaVersion, {
      async upgrade(db, oldVersion, newVersion, transaction) {
        if (!oldVersion) {
          db.createObjectStore('getCanonicalUrl');
          db.createObjectStore('getResolveRoot');
          db.createObjectStore('listEntries');
          db.createObjectStore('readFileContent');
        }

        await transaction.objectStore('getCanonicalUrl').clear();
        await transaction.objectStore('getResolveRoot').clear();
        await transaction.objectStore('listEntries').clear();
        await transaction.objectStore('readFileContent').clear();
      },
    }).catch(err => {
      console.error(err, 'error opening IndexedDB');

      return null;
    });
  }

  private async withMemoryCache<T, C = unknown>(
    href: string,
    loadFn: () => Promise<T>,
    cache: Map<string, T>,
    inflightMap: Map<string, Promise<T>>,
    storeName: string,
    serialize?: (result: T) => C,
    deserialize?: (cached: C) => T
  ): Promise<T> {
    if (cache.has(href)) {
      return cache.get(href)!;
    }

    const result = await this.withInflightGrouping(href, loadFn, inflightMap, storeName, serialize, deserialize);

    cache.set(href, result);

    return result;
  }

  private withInflightGrouping<T, C = unknown>(
    href: string,
    loadFn: () => Promise<T>,
    inflightMap: Map<string, Promise<T>>,
    storeName: string,
    serialize?: (result: T) => C,
    deserialize?: (cached: C) => T
  ): Promise<T> {
    let inflight = inflightMap.get(href);

    if (!inflight) {
      inflight = this.withIdbCache(href, loadFn, storeName, serialize, deserialize);

      inflightMap.set(href, inflight);
    }

    Promise.resolve(inflight)
      .catch(_ => undefined)
      .then(() => inflightMap.delete(href));

    return inflight;
  }

  private async withIdbCache<T, C = unknown>(
    href: string,
    loadFn: () => Promise<T>,
    storeName: string,
    serialize?: (result: T) => C,
    deserialize?: (cached: C) => T
  ): Promise<T> {
    const idb = await this.idbPromise.catch(_ => undefined);

    if (idb) {
      const cached = await withTimeout(
        this.idbTimeout,
        idb.get(storeName, href),
        `idb.get(${storeName}, ${href})`
      ).catch(_ => {
        // console.debug('[ResolverHostWithCache] %d MISS: timeout %s(%s)', this.limiter.size, storeName, href);
      });

      if (cached) {
        const result = (deserialize ? deserialize(cached as any) : cached) as T;

        return result;
      }
    }

    const result = await withTimeout(this.hostTimeout, loadFn(), `Timed out on operation '${storeName}' for '${href}'`);

    if (idb) {
      idb.put(storeName, serialize ? serialize(result) : result, href).catch(_ => undefined);
    }

    return result;
  }

  private withCache<T, C = unknown>(
    href: string,
    loadFn: () => Promise<T>,
    cache: Map<string, T>,
    inflightMap: Map<string, Promise<T>>,
    storeName: string,
    serialize?: (result: T) => C,
    deserialize?: (cached: C) => T
  ): Promise<T> {
    return this.withMemoryCache(href, loadFn, cache, inflightMap, storeName, serialize, deserialize);
  }

  async getCanonicalUrl(resolver: Resolver, url: URL) {
    const result = await this.withCache(
      url.href,
      () => this.host.getCanonicalUrl(resolver, url),
      this.getCanonicalUrlCache,
      this.inflightGetCanonicalUrl,
      'getCanonicalUrl',
      url => url.href,
      href => new URL(href)
    );

    return result;
  }

  async getResolveRoot(resolver: Resolver, url: URL) {
    const result = await this.withCache(
      url.href,
      () => this.host.getResolveRoot(resolver, url),
      this.getResolveRootCache,
      this.inflightGetResolveRoot,
      'getResolveRoot',
      url => url.href,
      href => new URL(href)
    );

    return result;
  }

  async listEntries(resolver: Resolver, url: URL) {
    const result = await this.withCache(
      url.href,
      () => this.host.listEntries(resolver, url),
      this.listEntriesCache,
      this.inflightListEntries,
      'listEntries',
      entries =>
        entries.map(entry => ({
          type: entry.type,
          href: entry.url.href,
        })),
      cached =>
        cached.map(entry => ({
          type: entry.type,
          url: new URL(entry.href),
        }))
    );

    return result;
  }

  async readFileContent(resolver: Resolver, url: URL) {
    try {
      const result = await this.withCache(
        url.href,
        () => this.host.readFileContent(resolver, url),
        this.readFileContentCache,
        this.inflightReadFileContent,
        'readFileContent'
      );

      return result;
    } catch (err) {
      throw err;
    }
  }
}

function withTimeout<T>(duration: number, promise: Promise<T>, message: string) {
  return Promise.race([
    promise,
    timeout(duration * 10).then(() => {
      // console.debug('[ResolverHostWithCache] TIMEOUT(%d): %s', duration, message);
      return Promise.reject(new TimeoutError(message));
    }),
  ]);
}