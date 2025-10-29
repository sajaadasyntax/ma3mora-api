declare module 'multer' {
  import { Request } from 'express';
  
  interface File {
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

  type FileFilterCallback = (error: Error | null, acceptFile: boolean) => void;

  interface Options {
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

  interface StorageEngine {
    _handleFile(req: Request, file: File, callback: (error?: Error | null, info?: Partial<File>) => void): void;
    _removeFile(req: Request, file: File, callback: (error: Error | null) => void): void;
  }

  interface Multer {
    (options?: Options): any;
    single(name: string): any;
    array(name: string, maxCount?: number): any;
    fields(fields: Array<{ name: string; maxCount?: number }>): any;
    none(): any;
    any(): any;
  }

  function multer(options?: Options): Multer;

  export = multer;
  export { File, FileFilterCallback, Options, StorageEngine, Multer };
}

