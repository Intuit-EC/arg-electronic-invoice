export interface InvoiceJobResult {
  accessKey: string;
  authorizationNumber: string;
  authorizedAt: string;
  invoiceId: string;
  xmlUrl: string;
  pdfUrl: string;
}

export interface EnqueueJobResponse {
  jobId: string;
  status: string;
  accessKey: string;
  enqueuedAt: Date;
}
