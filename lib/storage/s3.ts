import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageProvider } from './types';
import { createReadStream } from 'fs';
import { Readable } from 'stream';
import { Upload } from '@aws-sdk/lib-storage';

/** Files up to this size go up in one PUT; larger ones use multipart upload. */
const SINGLE_PUT_MAX_BYTES = 100 * 1024 * 1024;
const MULTIPART_PART_BYTES = 16 * 1024 * 1024;
import { stat } from 'fs/promises';

export class S3StorageProvider implements StorageProvider {
  private client: S3Client;
  private bucket: string;
  private publicDomain: string | null;

  constructor() {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || '';
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || '';
    this.bucket = process.env.R2_BUCKET_NAME || process.env.AWS_S3_BUCKET || 'riverside-clone';
    this.publicDomain = process.env.R2_PUBLIC_DOMAIN || null;

    let endpoint = process.env.R2_ENDPOINT_URL;
    if (!endpoint && accountId) {
      endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
    }

    if (!endpoint) {
      console.warn('[Cloudflare R2] Warning: R2_ENDPOINT_URL or CLOUDFLARE_ACCOUNT_ID missing in environment variables.');
    }

    this.client = new S3Client({
      region: 'auto', // Cloudflare R2 uses 'auto' region
      endpoint: endpoint || 'https://auto.r2.cloudflarestorage.com',
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  async save(path: string, data: Buffer | NodeJS.ReadableStream): Promise<void> {
    if (Buffer.isBuffer(data)) {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: path, Body: data, ContentType: contentTypeFor(path) }));
    } else {
      // Streams go up in parts instead of being buffered in memory.
      await this.multipart(path, data as Readable);
    }
    console.log(`[Cloudflare R2] Successfully uploaded object: ${path}`);
  }

  async saveFile(path: string, localFilePath: string): Promise<void> {
    const { size } = await stat(localFilePath);
    if (size <= SINGLE_PUT_MAX_BYTES) {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: path,
          Body: createReadStream(localFilePath),
          ContentLength: size,
          ContentType: contentTypeFor(path),
        })
      );
    } else {
      // Large exports (long multi-person episodes, hour-long tracks): parallel multipart upload,
      // retried per part, and no 5 GB single-PUT ceiling.
      await this.multipart(path, createReadStream(localFilePath));
    }
    console.log(`[Cloudflare R2] Uploaded ${path} (${(size / (1024 * 1024)).toFixed(1)} MB)`);
  }

  private async multipart(path: string, body: Readable): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: path, Body: body, ContentType: contentTypeFor(path) },
      partSize: MULTIPART_PART_BYTES,
      queueSize: 4,
      leavePartsOnError: false,
    });
    await upload.done();
  }

  async size(path: string): Promise<number | null> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: path }));
      return head.ContentLength ?? null;
    } catch {
      return null;
    }
  }

  async getSignedDownloadUrl(
    path: string,
    { filename, inline, contentType, expiresInSeconds = 3600 }: { filename?: string; inline?: boolean; contentType?: string; expiresInSeconds?: number }
  ): Promise<string> {
    const disposition = filename
      ? `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/"/g, '')}"`
      : inline ? 'inline' : 'attachment';
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: path,
      ResponseContentDisposition: disposition,
      ResponseContentType: contentType ?? contentTypeFor(path),
    });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  async read(path: string): Promise<Buffer> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: path,
    });

    const response = await this.client.send(command);
    if (!response.Body) {
      throw new Error(`Object body empty for ${path}`);
    }

    const byteArray = await response.Body.transformToByteArray();
    return Buffer.from(byteArray);
  }

  async exists(path: string): Promise<boolean> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: path,
      });
      await this.client.send(command);
      return true;
    } catch {
      return false;
    }
  }

  async delete(path: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: path,
    });
    await this.client.send(command);
  }

  async getStream(path: string): Promise<NodeJS.ReadableStream> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: path,
    });
    const response = await this.client.send(command);
    if (!response.Body) {
      throw new Error(`Object body empty for ${path}`);
    }
    const stream = response.Body as unknown as NodeJS.ReadableStream;
    return stream;
  }

  async getUrl(path: string, expiresInSeconds = 3600): Promise<string> {
    if (this.publicDomain) {
      const cleanDomain = this.publicDomain.replace(/\/$/, '');
      return `${cleanDomain}/${path}`;
    }

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: path,
    });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  /**
   * Helper method for generating direct client-to-R2 upload presigned URLs
   */
  async getPresignedUploadUrl(path: string, expiresInSeconds = 3600): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: path,
    });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }
}

function contentTypeFor(path: string): string {
  if (path.endsWith('.mp4')) return 'video/mp4';
  if (path.endsWith('.webm')) return 'video/webm';
  if (path.endsWith('.mkv')) return 'video/x-matroska';
  if (path.endsWith('.wav')) return 'audio/wav';
  if (path.endsWith('.mp3')) return 'audio/mpeg';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}
