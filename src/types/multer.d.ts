declare module 'multer' {
  import { Request } from 'express';
  
  export interface File {
    fieldname: string;
    originalname: string;
    encoding: string;
    mimetype: string;
    size: number;
    destination: string;
    filename: string;
    path: string;
    buffer?: Buffer;
  }

  export type FileFilterCallback = (error: Error | null, acceptFile?: boolean) => void;

  export interface Options {
    dest?: string;
    storage?: StorageEngine;
    fileFilter?: (req: Request, file: File, callback: FileFilterCallback) => void;
    limits?: {
      fieldNameSize?: number;
      fieldSize?: number;
      fields?: number;
      fileSize?: number;
      files?: number;
      headerPairs?: number;
    };
  }

  export interface StorageEngine {
    _handleFile(req: Request, file: File, callback: (error?: Error | null, info?: Partial<File>) => void): void;
    _removeFile(req: Request, file: File, callback: (error: Error | null) => void): void;
  }

  export interface DiskStorageOptions {
    destination?: string | ((req: Request, file: File, cb: (error: Error | null, destination: string) => void) => void);
    filename?: (req: Request, file: File, cb: (error: Error | null, filename: string) => void) => void;
  }

  export interface Multer {
    (options?: Options): any;
    single(name: string): any;
    array(name: string, maxCount?: number): any;
    fields(fields: Array<{ name: string; maxCount?: number }>): any;
    none(): any;
    any(): any;
  }

  interface MulterStatic extends Multer {
    diskStorage(options: DiskStorageOptions): StorageEngine;
  }

  function multer(options?: Options): MulterStatic;

  export = multer;
  export { File, FileFilterCallback, Options, StorageEngine, Multer, DiskStorageOptions };
}

