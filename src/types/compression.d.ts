declare module 'compression' {
  import { Request, Response, NextFunction } from 'express';
  
  interface CompressionOptions {
    level?: number;
    threshold?: number;
    filter?: (req: Request, res: Response) => boolean;
  }
  
  function compression(options?: CompressionOptions): (req: Request, res: Response, next: NextFunction) => void;
  export = compression;
}
