// This used to be needed because @sqlite.org/sqlite-wasm shipped no types at all for
// sqlite3Worker1Promiser (https://github.com/sqlite/sqlite-wasm/issues/53). That issue is now
// closed (PR #154), but this shim is still required for two separate reasons, both verified
// against the installed 3.53.0-build1 package (dist/index.mjs) and the "main" branch source
// (src/index.d.ts) as of 2026-08:
//
// 1. Upstream's own types never exported the Promiser/DbId/PromiserResponseSuccess/
//    PromiserResponseError/PromiserMethods names this codebase uses - it settled on a
//    differently-shaped generic API (Worker1PromiserFactory/Worker1Promiser/Worker1ArgsMap).
// 2. Upstream's declared signature for sqlite3Worker1Promiser (both in the published package and
//    in the current "main" branch source) still doesn't match the compiled ESM runtime: it's
//    typed as the synchronous "v1" factory plus a `.v2` method, but dist/index.mjs binds the
//    named export directly to `.v2`, so calling it already returns `Promise<Promiser>` with no
//    `.v2` sub-property. See the sqlite3Worker1Promiser declaration below for details.
//
// Re-check both of these against the then-current package version before removing this file.
//
// Note: this `declare module` block replaces (not merges with) upstream's own types once ANY
// `export` statement appears inside it — so every declaration below has an explicit `export`,
// even ones only used internally within this file, otherwise TypeScript treats the un-exported
// ones as module-private and every import of them elsewhere in this package breaks.
//
// https://github.com/cardstack/boxel/blob/main/packages/host/types/%40sqlite.org/sqlite-wasm/index.d.ts
// https://github.com/kristoferlund/ic-sqlite-chat/blob/main/src/frontend/src/sqlite.d.ts
// https://github.com/Ellipse120/nuxt-offline-sql-query/blob/main/types/sqlite-wasm.d.ts
// https://github.com/rejozacharia/athenamobile/blob/main/src/types/sqlite-wasm.d.ts

declare module "@sqlite.org/sqlite-wasm" {
  export type TODO = any

  /**
   * A function to be called when the SQLite3 module and worker APIs are done
   * loading asynchronously. This is the only way of knowing that the loading
   * has completed.
   *
   * @since V3.46: Is passed the function which gets returned by
   *   `sqlite3Worker1Promiser()`, as accessing it from this callback is more
   *   convenient for certain usage patterns. The promiser v2 interface obviates
   *   the need for this callback.
   */
  export type OnreadyFunction = (promiser: Promiser) => void

  export type Sqlite3Worker1PromiserConfig = {
    onready?: OnreadyFunction
    /**
     * A worker instance which loads `sqlite3-worker1.js`, or a functional
     * equivalent. Note that the promiser factory replaces the
     * `worker.onmessage` property. This config option may alternately be a
     * function, in which case this function is called to instantiate the
     * worker.
     */
    worker?: Worker | (() => Worker)
    /** Function to generate unique message IDs */
    generateMessageId?: (messageObject: TODO) => string
    /**
     * A `console.debug()` style function for logging information about Worker
     * messages.
     */
    debug?: (...args: any[]) => void
    /**
     * A callback function that is called when a `message` event is received
     * from the worker, and the event is not handled by the proxy.
     *
     * @note This *should* ideally never happen, as the proxy aims to handle
     * all known message types.
     */
    onunhandled?: (event: MessageEvent) => void
    /**
     * Undocumented in the upstream API docs, but present in the implementation:
     * called for library-internal error conditions (e.g. an unhandled worker
     * message). It is purely a diagnostic hook - it does NOT reject the
     * promiser's ready promise, so it cannot be used to detect e.g. the worker
     * script failing to load.
     */
    onerror?: (...args: unknown[]) => void
  }

  /**
   * A db identifier string (returned by 'open') which tells the operation which
   * database instance to work on. If not provided, the first-opened db is
   * used.
   *
   * @warning This is an "opaque" value, with no inherently useful syntax
   * or information. Its value is subject to change with any given build
   * of this API and cannot be used as a basis for anything useful beyond
   * its one intended purpose.
   */
  export type DbId = string | undefined
  export type Sqlite3Version = {
    libVersion: string
    sourceId: string
    libVersionNumber: number
    downloadVersion: number
  }

  // Message types and their corresponding arguments and results. Should be able to get better types for some of these (open, exec and stack) from the existing types, although the Promiser verions have minor differences
  export type PromiserMethods = {
    /** @link https://sqlite.org/wasm/doc/trunk/api-worker1.md#method-open */
    open: {
      args: Partial<
        {
          /**
           * The db filename. [=":memory:" or "" (unspecified)]: TODO: See the
           * sqlite3.oo1.DB constructor for peculiarities and transformations
           */
          filename?: string
        } & {
          /**
           * Sqlite3_vfs name. Ignored if filename is ":memory:" or "". This may
           * change how the given filename is resolved. The VFS may optionally
           * be provided via a URL-style filename argument: filename:
           * "file:foo.db?vfs=...". By default it uses a transient database,
           * created anew on each request.
           *
           * If both this argument and a URI-style argument are provided, which
           * one has precedence is unspecified.
           */
          vfs?: string
        }
      >
      result: {
        dbId: DbId
        /** Db filename, possibly differing from the input */
        filename: string
        /**
         * Indicates if the given filename resides in the known-persistent
         * storage
         */
        persistent: boolean
        /** Name of the underlying VFS */
        vfs: string
      }
      /** @link https://sqlite.org/wasm/doc/trunk/api-worker1.md#method-close */
    }
    close: {
      args: { dbId?: DbId }
      result: {
        /** Filename of closed db, or undefined if no db was closed */
        filename: string | undefined
      }
      /** @link https://sqlite.org/wasm/doc/trunk/api-worker1.md#method-config-get */
    }
    "config-get": {
      args: {}
      result: {
        dbID: DbId
        version: Sqlite3Version
        /** Indicates if BigInt support is enabled */
        bigIntEnabled: boolean
        /** Indicates if opfs support is enabled */
        opfsEnabled: boolean //not documented on sqlie.org?
        /** Result of sqlite3.capi.sqlite3_js_vfs_list() */
        vfsList: string[] // is there a full list somewhere I can use?
      }
    }
    /**
     * Interface for running arbitrary SQL. Wraps`oo1.DB.exec()` methods. And
     * supports most of its features as defined in
     * https://sqlite.org/wasm/doc/trunk/api-oo1.md#db-exec. There are a few
     * limitations imposed by the state having to cross thread boundaries.
     *
     * @link https://sqlite.org/wasm/doc/trunk/api-worker1.md#method-exec
     */
    exec: {
      args: {
        sql: string
        dbId?: DbId
        /**
         * At the end of the result set, the same event is fired with
         * (row=undefined, rowNumber=null) to indicate that the end of the
         * result set has been reached. Note that the rows arrive via
         * worker-posted messages, with all the implications of that.
         */
        callback?: (result: {
          /**
           * Internally-synthesized message type string used temporarily for
           * worker message dispatching.
           */
          type: string
          /** Sqlilte3 VALUE */
          row: TODO
          /** 1-based index */
          rowNumber: number
          columnNames: string[]
        }) => void
        /**
         * A single value valid as an argument for Stmt.bind(). This is only
         * applied to the first non-empty statement in the SQL which has any
         * bindable parameters. (Empty statements are skipped entirely.)
         */
        bind?: Exclude<TODO, null>
        /**
         * If truthy, `result.changeCount` is populated with the number of rows
         * changed by the SQL (via `sqlite3_total_changes()` before/after).
         * Added in 3.43.
         */
        countChanges?: boolean
        /**
         * If truthy, `result.lastInsertRowId` is populated with the result of
         * `sqlite3_last_insert_rowid()`, fetched once after the SQL runs. This
         * API has no idea whether the SQL contains an INSERT, so it's up to the
         * caller to only rely on this when it makes sense. Added in 3.50.0.
         */
        lastInsertRowId?: boolean
        [key: string]: TODO //
      }
      // result: { [key: string]: TODO };
      result: {
        dbId: string
        sql: string
        // INSERT
        bind?: Record<number, any>[]
        changeCount?: number
        /** Result of sqlite3_last_insert_rowid(), only set when requested via args.lastInsertRowId. */
        lastInsertRowId?: bigint
        // SELECT
        resultRows?: Record<string, any>[]
        returnValue?: string
        rowMode?: string
      }
    }
  }

  export type PromiserResponseSuccess<T extends keyof PromiserMethods> = {
    /** Type of the inbound message */
    type: T
    /** Operation dependent result */
    result: PromiserMethods[T]["result"]
    /** Same value, if any, provided by the inbound message */
    messageId: string
    /**
     * The id of the db which was operated on, if any, as returned by the
     * corresponding 'open' operation.
     */
    dbId: DbId
    // possibly other metadata ...
    /*
    WorkerReceivedTime: number
    WorkerRespondTime: number
    departureTime: number
     */
  }

  export type PromiserResponseError = {
    type: "error"
    /** Operation independent object */
    result: {
      /** Type of the triggereing operation */
      operation: string
      /** Error Message */
      message: string
      /** The ErrorClass.name property from the thrown exception */
      errorClass: string
      /** The message object which triggered the error */
      input: object
      /** _if available_ a stack trace array */
      stack: TODO[]
    }
    /** Same value, if any, provided by the inbound message */
    messageId: string
    dbId: DbId
  }
  export type PromiserResponse<T extends keyof PromiserMethods> = PromiserResponseSuccess<T> | PromiserResponseError

  /**
   * The promiser's resolved value is always the success response. On failure the returned
   * Promise REJECTS with a `PromiserResponseError`-shaped plain object (verified against
   * dist/index.mjs: `case "error": msgHandler.reject(ev)` — errors are not resolved, and the
   * rejection value is a plain object, not an Error instance). Callers must try/catch and
   * detect the error shape themselves.
   */
  export type Promiser = {
    <T extends keyof PromiserMethods>(
      /** The type of the message */
      messageType: T,
      /** The arguments for the message type */
      messageArguments: PromiserMethods[T]["args"],
    ): Promise<PromiserResponseSuccess<T>>

    <T extends keyof PromiserMethods>(message: {
      /** The type of the message */
      type: T
      /** The arguments for the message type */
      args: PromiserMethods[T]["args"]
    }): Promise<PromiserResponseSuccess<T>>
  }

  /**
   * Factory for creating promiser instances.
   *
   * @warning The upstream package's own bundled `.d.ts` (as of
   * 3.53.0-build1) still declares this as the synchronous "v1" signature
   * plus a separate `.v2` method, but that no longer matches the compiled
   * ESM output: `dist/index.mjs` binds the `sqlite3Worker1Promiser` export
   * to `sqlite3Worker1Promiser.v2` directly (there is no `.v2` sub-property
   * at runtime), so calling it already returns `Promise<Promiser>`. This
   * shim reflects the real runtime behavior, not the (currently incorrect)
   * upstream types. See https://github.com/sqlite/sqlite-wasm/issues/53.
   *
   * @example
   *   const factory = await sqlite3Worker1Promiser({
   *     onerror: (...args) => console.error(...args),
   *   });
   *
   * @link https://sqlite.org/wasm/doc/trunk/api-worker1.md#promiser.v2
   */
  export const sqlite3Worker1Promiser: {
    (config?: Sqlite3Worker1PromiserConfig | OnreadyFunction): Promise<Promiser>
    defaultConfig: Sqlite3Worker1PromiserConfig
  }

  /**
   * Minimal subset of the real oo1.DB/Sqlite3Static surface, needed by
   * adapters/memory.ts (single-thread Node/main-thread usage via the default
   * export, no Worker involved). This ambient `declare module` block replaces
   * — rather than merges with — the upstream package's own real types (see
   * the warning above sqlite3Worker1Promiser), so anything imported from this
   * module elsewhere in this package must be declared here too, even names
   * that upstream already exports correctly.
   */
  export class Database {
    constructor(filename?: string, flags?: string, vfs?: string)
    pointer?: number
    exec(opts: { sql: string; bind?: TODO }): this
    selectObjects(sql: string, bind?: TODO): Record<string, TODO>[]
    changes(total?: boolean, sixtyFour?: boolean): number
    close(): void
  }

  export type Sqlite3Static = {
    oo1: {
      DB: typeof Database
    }
    capi: {
      sqlite3_last_insert_rowid: (db: number) => bigint
    }
  }

  export default function sqlite3InitModule(moduleArg?: TODO): Promise<Sqlite3Static>
}
