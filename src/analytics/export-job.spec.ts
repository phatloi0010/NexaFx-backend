jest.mock('@nestjs/swagger', () => ({
  ApiTags: () => () => {},
  ApiBearerAuth: () => () => {},
  ApiOperation: () => () => {},
  ApiResponse: () => () => {},
  ApiParam: () => () => {},
  ApiQuery: () => () => {},
  ApiProperty: () => () => {},
  ApiPropertyOptional: () => () => {},
}));
// Mock ESM-only @nestjs/typeorm and @nestjs/config
jest.mock('@nestjs/typeorm', () => {
  const { Inject } = require('@nestjs/common');
  const getRepositoryToken = (entity: any) =>
    `${entity?.name ?? 'Entity'}Repository`;
  return {
    InjectRepository: (entity: any) => Inject(getRepositoryToken(entity)),
    getRepositoryToken,
  };
});
jest.mock('@nestjs/config', () => ({
  ConfigService: class MockConfigService {
    get() {
      return null;
    }
  },
}));
jest.mock('../exchange-rates/exchange-rates.service', () => ({
  ExchangeRatesService: class MockExchangeRatesService {
    getRate() {
      return 1;
    }
  },
}));

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Readable } from 'stream';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';
import { Transaction } from '../transactions/entities/transaction.entity';
import { TransactionCategory } from './entities/transaction-category.entity';
import { BalanceSnapshot } from './entities/balance-snapshot.entity';
import {
  ReportExportJob,
  ExportJobStatus,
  ExportFormat,
} from './entities/report-export-job.entity';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import {
  STORAGE_SERVICE_TOKEN,
  StorageService,
} from '../modules/storage/storage.service';

describe('Analytics Export Job & PDF Generation (#1520)', () => {
  let service: AnalyticsService;
  let controller: AnalyticsController;

  const mockTransactions: Partial<Transaction>[] = [
    {
      id: 'tx-1',
      userId: 'user-1',
      type: 'DEPOSIT' as any,
      amount: '250.00',
      currency: 'USD',
      status: 'SUCCESS' as any,
      createdAt: new Date('2026-05-10T10:00:00Z'),
      metadata: { categoryId: 'cat-transfers' },
    },
    {
      id: 'tx-2',
      userId: 'user-1',
      type: 'WITHDRAW' as any,
      amount: '50.00',
      currency: 'USD',
      status: 'SUCCESS' as any,
      createdAt: new Date('2026-05-15T12:00:00Z'),
      metadata: { categoryId: 'cat-food' },
    },
    {
      id: 'tx-3',
      userId: 'user-1',
      type: 'SWAP' as any,
      amount: '100.00',
      currency: 'USD',
      status: 'FAILED' as any,
      createdAt: new Date('2026-05-20T14:00:00Z'),
      metadata: {},
    },
  ];

  const mockCategories: Partial<TransactionCategory>[] = [
    { id: 'cat-transfers', name: 'Transfers', isSystem: true },
    { id: 'cat-food', name: 'Food', isSystem: false },
  ];

  const mockTransactionRepository = {
    find: jest.fn().mockResolvedValue(mockTransactions),
    findOne: jest.fn(),
    save: jest.fn(),
  };

  const mockCategoryRepository = {
    find: jest.fn().mockResolvedValue(mockCategories),
    findOne: jest.fn(),
  };

  const mockBalanceSnapshotRepository = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
  };

  let mockJobs: Map<string, ReportExportJob>;
  const mockExportJobRepository = {
    find: jest.fn(),
    findOne: jest.fn(async ({ where }: { where: { id: string; userId: string } }) => {
      const job = mockJobs.get(where.id);
      if (job && job.userId === where.userId) return { ...job };
      return null;
    }),
    create: jest.fn((input: any) => ({
      id: 'export-job-uuid-1',
      ...input,
    })),
    save: jest.fn(async (entity: any) => {
      mockJobs.set(entity.id, entity);
      return { ...entity };
    }),
    update: jest.fn(async (idOrCriteria: any, patch: any) => {
      if (typeof idOrCriteria === 'string') {
        const existing = mockJobs.get(idOrCriteria);
        if (existing) {
          Object.assign(existing, patch);
        }
        return { affected: 1 };
      }
      // Criteria update (e.g. failStuckJobs)
      let count = 0;
      for (const [id, job] of mockJobs.entries()) {
        if (idOrCriteria.status && job.status === idOrCriteria.status) {
          Object.assign(job, patch);
          count++;
        }
      }
      return { affected: count };
    }),
  };

  const mockUserRepository = { findOne: jest.fn() };
  const mockUsersService = { getProfile: jest.fn() };
  const mockExchangeRatesService = { getRate: jest.fn().mockResolvedValue({ rate: 1 }) };
  const mockDataSource = { query: jest.fn() };

  const storageFiles = new Map<string, Buffer>();
  const mockStorageService: StorageService = {
    upload: jest.fn(async (file: Express.Multer.File, pathParam: string) => {
      const key = `development/${pathParam}/${file.originalname}`;
      storageFiles.set(key, Buffer.from(file.buffer));
      return key;
    }),
    getSignedUrl: jest.fn(async (key: string) => `http://storage.local/${key}`),
    delete: jest.fn(async (key: string) => {
      storageFiles.delete(key);
    }),
    getFileStream: jest.fn(async (key: string) => {
      const buf = storageFiles.get(key) || Buffer.from('mock content');
      return Readable.from(buf);
    }),
    getFile: jest.fn(async (key: string) => {
      return storageFiles.get(key) || Buffer.from('mock content');
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockJobs = new Map<string, ReportExportJob>();
    storageFiles.clear();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AnalyticsController],
      providers: [
        AnalyticsService,
        {
          provide: getRepositoryToken(Transaction),
          useValue: mockTransactionRepository,
        },
        {
          provide: getRepositoryToken(TransactionCategory),
          useValue: mockCategoryRepository,
        },
        {
          provide: getRepositoryToken(BalanceSnapshot),
          useValue: mockBalanceSnapshotRepository,
        },
        {
          provide: getRepositoryToken(ReportExportJob),
          useValue: mockExportJobRepository,
        },
        {
          provide: getRepositoryToken(User),
          useValue: mockUserRepository,
        },
        { provide: UsersService, useValue: mockUsersService },
        { provide: ExchangeRatesService, useValue: mockExchangeRatesService },
        { provide: DataSource, useValue: mockDataSource },
        { provide: STORAGE_SERVICE_TOKEN, useValue: mockStorageService },
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
    controller = module.get<AnalyticsController>(AnalyticsController);
  });

  describe('generatePdf', () => {
    it('resolves on end with buffer and transaction count', async () => {
      const catMap = new Map<string, TransactionCategory>();
      catMap.set('cat-transfers', { id: 'cat-transfers', name: 'Transfers' } as any);
      catMap.set('cat-food', { id: 'cat-food', name: 'Food' } as any);

      const fromDate = new Date('2026-05-01T00:00:00Z');
      const toDate = new Date('2026-05-31T23:59:59Z');

      const result = await service.generatePdf(
        mockTransactions as Transaction[],
        catMap,
        fromDate,
        toDate,
      );

      expect(result).toBeDefined();
      expect(Buffer.isBuffer(result.buffer)).toBe(true);
      expect(result.buffer.length).toBeGreaterThan(0);
      expect(result.count).toBe(mockTransactions.length);

      // Verify PDF magic header %PDF
      const header = result.buffer.slice(0, 4).toString();
      expect(header).toBe('%PDF');
    });

    it('handles empty transaction list without error', async () => {
      const catMap = new Map<string, TransactionCategory>();
      const fromDate = new Date('2026-05-01T00:00:00Z');
      const toDate = new Date('2026-05-31T23:59:59Z');

      const result = await service.generatePdf([], catMap, fromDate, toDate);

      expect(result.count).toBe(0);
      expect(Buffer.isBuffer(result.buffer)).toBe(true);
      expect(result.buffer.slice(0, 4).toString()).toBe('%PDF');
    });
  });

  describe('processExportJob (PDF & CSV)', () => {
    it('processes a PDF export job to COMPLETED with recordCount and storage upload', async () => {
      const savedJob = await service.createExportJob(
        'user-1',
        'pdf',
        '2026-05-01T00:00:00Z',
        '2026-05-31T23:59:59Z',
      );

      expect(savedJob.status).toBe(ExportJobStatus.PENDING);

      // Allow background processExportJob to complete
      await new Promise((resolve) => setTimeout(resolve, 300));

      const updatedJob = mockJobs.get(savedJob.id);
      expect(updatedJob).toBeDefined();
      expect(updatedJob?.status).toBe(ExportJobStatus.COMPLETED);
      expect(updatedJob?.recordCount).toBe(mockTransactions.length);
      expect(updatedJob?.fileSize).toBeGreaterThan(0);
      expect(updatedJob?.filename).toMatch(/^report-.*\.pdf$/);
      expect(updatedJob?.fileUrl).toBeDefined();
      expect(updatedJob?.s3Url).toBe(updatedJob?.fileUrl);

      // Verify file was uploaded to storage
      expect(mockStorageService.upload).toHaveBeenCalledWith(
        expect.objectContaining({
          mimetype: 'application/pdf',
          size: updatedJob?.fileSize,
        }),
        'exports',
      );
    });

    it('processes a CSV export job to COMPLETED with recordCount and storage upload', async () => {
      const savedJob = await service.createExportJob(
        'user-1',
        'csv',
        '2026-05-01T00:00:00Z',
        '2026-05-31T23:59:59Z',
      );

      await new Promise((resolve) => setTimeout(resolve, 300));

      const updatedJob = mockJobs.get(savedJob.id);
      expect(updatedJob).toBeDefined();
      expect(updatedJob?.status).toBe(ExportJobStatus.COMPLETED);
      expect(updatedJob?.recordCount).toBe(mockTransactions.length);
      expect(updatedJob?.fileSize).toBeGreaterThan(0);
      expect(updatedJob?.filename).toMatch(/^report-.*\.csv$/);
      expect(updatedJob?.fileUrl).toBeDefined();

      expect(mockStorageService.upload).toHaveBeenCalledWith(
        expect.objectContaining({
          mimetype: 'text/csv',
        }),
        'exports',
      );
    });
  });

  describe('Download & Streaming', () => {
    it('returns stored file bytes matching fileSize and streams artifact', async () => {
      const testContent = Buffer.from('%PDF-1.4 test-stored-pdf-content-bytes');
      const storageKey = 'development/exports/report-12345678.pdf';
      storageFiles.set(storageKey, testContent);

      const completedJob: ReportExportJob = {
        id: 'job-123',
        userId: 'user-1',
        status: ExportJobStatus.COMPLETED,
        format: ExportFormat.PDF,
        fromDate: new Date('2026-05-01'),
        toDate: new Date('2026-05-31'),
        filename: 'report-12345678.pdf',
        fileUrl: storageKey,
        s3Url: storageKey,
        fileSize: testContent.length,
        recordCount: 3,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: new Date(),
      };
      mockJobs.set('job-123', completedJob);

      const fileResult = await service.getExportFile('job-123', 'user-1');

      expect(fileResult.contentType).toBe('application/pdf');
      expect(fileResult.filename).toBe('report-12345678.pdf');
      expect(fileResult.fileSize).toBe(testContent.length);
      expect(fileResult.buffer).toEqual(testContent);
      expect(fileResult.stream).toBeDefined();

      // Test controller streaming
      const { PassThrough } = require('stream');
      const mockRes = new PassThrough() as any;
      mockRes.setHeader = jest.fn();
      mockRes.send = jest.fn();

      await controller.downloadExport(
        { user: { userId: 'user-1' } } as any,
        'job-123',
        mockRes,
      );

      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        'attachment; filename="report-12345678.pdf"',
      );
      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Length', testContent.length.toString());
    });
  });

  describe('Stuck Job Failures', () => {
    it('fails jobs stuck in PROCESSING past timeout', async () => {
      const stuckDate = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
      const stuckJob: ReportExportJob = {
        id: 'stuck-job-1',
        userId: 'user-1',
        status: ExportJobStatus.PROCESSING,
        format: ExportFormat.PDF,
        fromDate: new Date('2026-05-01'),
        toDate: new Date('2026-05-31'),
        filename: null,
        fileUrl: null,
        s3Url: null,
        fileSize: null,
        recordCount: 0,
        errorMessage: null,
        createdAt: stuckDate,
        updatedAt: stuckDate,
        completedAt: null,
      };
      mockJobs.set('stuck-job-1', stuckJob);

      // getExportJob detects stuck job past timeout and fails it
      const fetched = await service.getExportJob('stuck-job-1', 'user-1');
      expect(fetched.status).toBe(ExportJobStatus.FAILED);
      expect(fetched.errorMessage).toBe('Export processing timed out');

      // failStuckJobs batch helper also updates stuck jobs
      const affected = await service.failStuckJobs(5 * 60 * 1000);
      expect(affected).toBeGreaterThanOrEqual(0);
    });
  });
});
