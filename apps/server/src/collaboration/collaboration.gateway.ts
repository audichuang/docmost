import { Hocuspocus } from '@hocuspocus/server';
import { IncomingMessage } from 'http';
import WebSocket from 'ws';
import { AuthenticationExtension } from './extensions/authentication.extension';
import { PersistenceExtension } from './extensions/persistence.extension';
import { Injectable } from '@nestjs/common';
import { EnvironmentService } from '../integrations/environment/environment.service';
import {
  createRetryStrategy,
  parseRedisUrl,
  RedisConfig,
} from '../common/helpers';
import { LoggerExtension } from './extensions/logger.extension';
import {
  RedisSyncExtension,
  SerializedHTTPRequest,
} from './extensions/redis-sync';
import { toWebRequest } from './extensions/redis-sync/redis-sync.types';
import { WsSocketWrapper } from './extensions/redis-sync/ws-socket-wrapper';
import RedisClient from 'ioredis';
import { pack, unpack } from 'msgpackr';
import { nanoid } from 'nanoid';
import * as os from 'node:os';
import { CollabWsAdapter } from './adapter/collab-ws.adapter';
import {
  CollaborationHandler,
  CollabEventHandlers,
} from './collaboration.handler';

@Injectable()
export class CollaborationGateway {
  private readonly hocuspocus: Hocuspocus;
  private redisConfig: RedisConfig;
  // @ts-ignore
  private readonly redisSync: RedisSyncExtension<CollabEventHandlers> | null =
    null;
  private readonly withRedis: boolean;

  constructor(
    private authenticationExtension: AuthenticationExtension,
    private persistenceExtension: PersistenceExtension,
    private loggerExtension: LoggerExtension,
    private environmentService: EnvironmentService,
    private collabEventsService: CollaborationHandler,
  ) {
    this.redisConfig = parseRedisUrl(this.environmentService.getRedisUrl());
    this.withRedis = !this.environmentService.isCollabDisableRedis();

    this.hocuspocus = new Hocuspocus({
      debounce: 10000,
      maxDebounce: 45000,
      unloadImmediately: false,
      extensions: [
        this.authenticationExtension,
        this.persistenceExtension,
        this.loggerExtension,
      ],
    });

    if (this.withRedis) {
      // @ts-ignore
      this.redisSync = new RedisSyncExtension({
        redis: new RedisClient({
          host: this.redisConfig.host,
          port: this.redisConfig.port,
          password: this.redisConfig.password,
          db: this.redisConfig.db,
          family: this.redisConfig.family,
          retryStrategy: createRetryStrategy(),
        }),
        serverId: `collab-${os?.hostname()}-${nanoid(10)}`,
        prefix: 'collab',
        pack,
        unpack,
        // @ts-ignore
        customEvents: this.collabEventsService.getHandlers(this.hocuspocus),
      });
      this.hocuspocus.configuration.extensions.push(this.redisSync);
      // @ts-ignore
      this.redisSync.onConfigure({ instance: this.hocuspocus });
    }
  }

  private serializeRequest(request: IncomingMessage): SerializedHTTPRequest {
    return {
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      headers: {
        'sec-websocket-key': request.headers['sec-websocket-key'] ?? '',
        'sec-websocket-protocol':
          request.headers['sec-websocket-protocol'] ?? '',
      },
      socket: { remoteAddress: request.socket?.remoteAddress ?? '' },
    };
  }

  handleConnection(client: WebSocket, request: IncomingMessage): any {
    if (this.redisSync) {
      const serializedHTTPRequest = this.serializeRequest(request);
      const socketId = serializedHTTPRequest.headers['sec-websocket-key'];

      const wrappedSocket = new WsSocketWrapper(client);

      // Route through RedisSync extension (this calls handleConnection internally)
      this.redisSync.onSocketOpen(wrappedSocket, serializedHTTPRequest);

      client.on('message', (data: ArrayBuffer) => {
        this.redisSync!.onSocketMessage(serializedHTTPRequest, data);
      });

      client.on('close', (code: number, reason: Buffer) => {
        this.redisSync!.onSocketClose(
          socketId,
          code,
          new Uint8Array(reason).buffer,
        );
      });
    } else {
      // Fallback to direct Hocuspocus connection
      const clientConnection = this.hocuspocus.handleConnection(
        client,
        toWebRequest(this.serializeRequest(request)),
      );

      client.on('message', (data: Buffer) => {
        clientConnection.handleMessage(new Uint8Array(data));
      });

      client.on('close', (code: number, reason: Buffer) => {
        clientConnection.handleClose({ code, reason: reason.toString() });
      });
    }
  }

  getConnectionCount() {
    return this.hocuspocus.getConnectionsCount();
  }

  getDocumentCount() {
    return this.hocuspocus.getDocumentsCount();
  }

  /**
   * Applies a Yjs collaboration event (e.g. a content update from the GitHub
   * sync, or a comment mark) to a document.
   *
   * When Redis sync is configured, it decides whether to apply the event on
   * this node or proxy it to whichever node currently owns the document.
   *
   * When there is no Redis sync extension (COLLAB_DISABLE_REDIS=true,
   * single-node mode), `this.redisSync` is null and there is no other node
   * to proxy to, so the event is applied directly against this node's own
   * hocuspocus instance instead (the same handlers redisSync would have run
   * locally, see CollaborationHandler.getHandlers).
   *
   * A1 fix: previously this was `return this.redisSync?.handleEvent(...)`,
   * which resolved to `undefined` with no write at all when redisSync was
   * null — a silent no-op. Marking this `async` and always either returning
   * a real write or throwing means a caller's `await` can no longer be lied
   * to about success.
   */
  async handleYjsEvent<TName extends keyof CollabEventHandlers>(
    eventName: TName,
    documentName: string,
    payload: Parameters<CollabEventHandlers[TName]>[1],
  ) {
    if (this.redisSync) {
      return this.redisSync.handleEvent(eventName, documentName, payload);
    }

    const handler =
      this.collabEventsService.getHandlers(this.hocuspocus)[eventName];
    if (!handler) {
      throw new Error(`Invalid eventName: ${String(eventName)}`);
    }
    // Dynamic dispatch on a generically-indexed handler: same `payload: any`
    // escape hatch RedisSyncExtension.handleEvent already uses internally
    // for this exact pattern.
    return handler(documentName, payload as any);
  }

  openDirectConnection(documentName: string, context?: any) {
    return this.hocuspocus.openDirectConnection(documentName, context);
  }

  /*
   *Can be used before calling openDirectConnection directly
   */
  async lockDocument(documentName: string) {
    return this.redisSync.lockDocument(documentName);
  }

  /*
   *Releases a document lock and stops the interval that maintains it.
   */
  async releaseLock(documentName: string) {
    return this.redisSync.releaseLock(documentName);
  }

  async destroy(collabWsAdapter: CollabWsAdapter): Promise<void> {
    // eslint-disable-next-line no-async-promise-executor
    await new Promise(async (resolve) => {
      try {
        // Wait for all documents to unload
        this.hocuspocus.configuration.extensions.push({
          async afterUnloadDocument({ instance }) {
            if (instance.getDocumentsCount() === 0) resolve('');
          },
        });

        collabWsAdapter?.close();

        if (this.hocuspocus.getDocumentsCount() === 0) resolve('');
        this.hocuspocus.closeConnections();
        this.hocuspocus.flushPendingStores();
      } catch (error) {
        console.error(error);
      }
    });

    await this.hocuspocus.hooks('onDestroy', { instance: this.hocuspocus });
  }
}
