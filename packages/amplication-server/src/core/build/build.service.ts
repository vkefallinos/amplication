import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Storage, MethodNotSupported } from '@slynova/flydrive';
import { GoogleCloudStorage } from '@slynova/flydrive-gcs';
import { StorageService } from '@codebrew/nestjs-storage';
import { subSeconds } from 'date-fns';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import * as winston from 'winston';
import { LEVEL, MESSAGE, SPLAT } from 'triple-beam';
import { groupBy, omit, orderBy } from 'lodash';
import path from 'path';
import * as DataServiceGenerator from '@amplication/data-service-generator';
import { ContainerBuilderService } from '@amplication/container-builder/dist/nestjs';
import {
  BuildResult,
  EnumBuildStatus as ContainerBuildStatus
} from '@amplication/container-builder/dist/';
import { AppRole } from 'src/models';
import { Build } from './dto/Build';
import { CreateBuildArgs } from './dto/CreateBuildArgs';
import { FindManyBuildArgs } from './dto/FindManyBuildArgs';
import { getBuildZipFilePath, getBuildTarGzFilePath } from './storage';
import { EnumBuildStatus } from './dto/EnumBuildStatus';
import { FindOneBuildArgs } from './dto/FindOneBuildArgs';
import { BuildNotFoundError } from './errors/BuildNotFoundError';
import { EntityService } from '..';
import { StepNotCompleteError } from './errors/StepNotCompleteError';
import { BuildResultNotFound } from './errors/BuildResultNotFound';
import { EnumActionStepStatus } from '../action/dto/EnumActionStepStatus';
import { EnumActionLogLevel } from '../action/dto/EnumActionLogLevel';
import { AppRoleService } from '../appRole/appRole.service';
import { AppService } from '../app/app.service'; // eslint-disable-line import/no-cycle
import { ActionService } from '../action/action.service';
import { ActionStep } from '../action/dto';
import { createZipFileFromModules } from './zip';
import { LocalDiskService } from '../storage/local.disk.service';
import { createTarGzFileFromModules } from './tar';
import { Deployment } from '../deployment/dto/Deployment';
import { DeploymentService } from '../deployment/deployment.service';
import { FindManyDeploymentArgs } from '../deployment/dto/FindManyDeploymentArgs';
import { StepNotFoundError } from './errors/StepNotFoundError';

import { GithubService } from '../github/github.service';
import fs from 'fs'
import simpleGit, { SimpleGit } from 'simple-git';
export const HOST_VAR = 'HOST';
export const GENERATE_STEP_MESSAGE = 'Generating Application';
export const GENERATE_STEP_NAME = 'GENERATE_APPLICATION';
export const BUILD_DOCKER_IMAGE_STEP_MESSAGE = 'Building Docker image';
export const BUILD_DOCKER_IMAGE_STEP_NAME = 'BUILD_DOCKER';
export const BUILD_DOCKER_IMAGE_STEP_FINISH_LOG =
  'Built Docker image successfully';
export const BUILD_DOCKER_IMAGE_STEP_FAILED_LOG = 'Build Docker failed';
export const BUILD_DOCKER_IMAGE_STEP_RUNNING_LOG =
  'Waiting for Docker image...';
export const BUILD_DOCKER_IMAGE_STEP_START_LOG =
  'Starting to build Docker image. It should take a few minutes.';

export const PUSH_TO_GITHUB_STEP_NAME = 'PUSH_TO_GITHUB';
export const PUSH_TO_GITHUB_STEP_MESSAGE = 'Push changes to GitHub';
export const PUSH_TO_GITHUB_STEP_START_LOG =
  'Starting to push changes to GitHub.';
export const PUSH_TO_GITHUB_STEP_FINISH_LOG =
  'Successfully pushed changes to GitHub';
export const PUSH_TO_GITHUB_STEP_FAILED_LOG = 'Push changes to GitHub failed';

export const ACTION_ZIP_LOG = 'Creating ZIP file';
export const ACTION_JOB_DONE_LOG = 'Build job done';
export const JOB_STARTED_LOG = 'Build job started';
export const JOB_DONE_LOG = 'Build job done';
export const ENTITIES_INCLUDE = {
  fields: true,
  permissions: {
    include: {
      permissionRoles: {
        include: {
          appRole: true
        }
      },
      permissionFields: {
        include: {
          field: true,
          permissionRoles: {
            include: {
              appRole: true
            }
          }
        }
      }
    }
  }
};
export const ACTION_INCLUDE = {
  action: {
    include: {
      steps: true
    }
  }
};

const WINSTON_LEVEL_TO_ACTION_LOG_LEVEL: {
  [level: string]: EnumActionLogLevel;
} = {
  error: EnumActionLogLevel.Error,
  warn: EnumActionLogLevel.Warning,
  info: EnumActionLogLevel.Info,
  debug: EnumActionLogLevel.Debug
};

const WINSTON_META_KEYS_TO_OMIT = [LEVEL, MESSAGE, SPLAT, 'level'];

export function createInitialStepData(version: string, message: string) {
  return {
    message: 'Adding task to queue',
    name: 'ADD_TO_QUEUE',
    status: EnumActionStepStatus.Success,
    completedAt: new Date(),
    logs: {
      create: [
        {
          level: EnumActionLogLevel.Info,
          message: 'create build generation task',
          meta: {}
        },
        {
          level: EnumActionLogLevel.Info,
          message: `Build Version: ${version}`,
          meta: {}
        },
        {
          level: EnumActionLogLevel.Info,
          message: `Build message: ${message}`,
          meta: {}
        }
      ]
    }
  };
}

const CONTAINER_STATUS_UPDATE_INTERVAL_SEC = 10;

@Injectable()
export class BuildService {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    private readonly entityService: EntityService,
    private readonly appRoleService: AppRoleService,
    private readonly actionService: ActionService,
    private readonly containerBuilderService: ContainerBuilderService,
    private readonly localDiskService: LocalDiskService,
    private readonly deploymentService: DeploymentService,
    private readonly githubService: GithubService,
    @Inject(forwardRef(() => AppService))
    private readonly appService: AppService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: winston.Logger
  ) {
    /** @todo move this to storageService config once possible */
    this.storageService.registerDriver('gcs', GoogleCloudStorage);
  }

  async create(args: CreateBuildArgs, skipPublish?: boolean): Promise<Build> {
    const appId = args.data.app.connect.id;

    /**@todo: set version based on release when applicable */
    const commitId = args.data.commit.connect.id;
    const version = commitId.slice(commitId.length - 8);

    const latestEntityVersions = await this.entityService.getLatestVersions({
      where: { app: { id: appId } }
    });

    const build = await this.prisma.build.create({
      ...args,
      data: {
        ...args.data,
        version,

        createdAt: new Date(),
        blockVersions: {
          connect: []
        },
        entityVersions: {
          connect: latestEntityVersions.map(version => ({ id: version.id }))
        },
        action: {
          create: {
            steps: {
              create: createInitialStepData(version, args.data.message)
            }
          } //create action record
        }
      },
      include: {
        commit: true,
        app: true
      }
    });

    const logger = this.logger.child({
      buildId: build.id
    });
    logger.info(JOB_STARTED_LOG);
    const tarballURL = await this.generate(build);
    if (!skipPublish) {
      await this.buildDockerImage(build, tarballURL);
    }
    logger.info(JOB_DONE_LOG);

    return build;
  }

  async findMany(args: FindManyBuildArgs): Promise<Build[]> {
    return this.prisma.build.findMany(args);
  }

  async findOne(args: FindOneBuildArgs): Promise<Build | null> {
    return this.prisma.build.findUnique(args);
  }

  /**
   * Gets the updated status of running "build container" tasks from
   * containerBuilderService, and updates the step status. This function should
   * be called periodically from an external scheduler
   */
  async updateRunningBuildsStatus(): Promise<void> {
    const lastUpdateThreshold = subSeconds(
      new Date(),
      CONTAINER_STATUS_UPDATE_INTERVAL_SEC
    );

    // find all builds that have a running "build docker" step
    const builds = await this.prisma.build.findMany({
      where: {
        containerStatusUpdatedAt: {
          lt: lastUpdateThreshold
        },
        action: {
          steps: {
            some: {
              status: {
                equals: EnumActionStepStatus.Running
              },
              name: {
                equals: BUILD_DOCKER_IMAGE_STEP_NAME
              }
            }
          }
        }
      },
      orderBy: {
        createdAt: Prisma.SortOrder.asc
      },
      include: ACTION_INCLUDE
    });

    const groups = groupBy(builds, build => build.appId);

    //In case we have multiple builds for the same app run them one after the other based on creation time
    await Promise.all(
      Object.entries(groups).map(async ([appId, groupBuilds]) => {
        for (const build of groupBuilds) {
          const stepBuildDocker = build.action.steps.find(
            step => step.name === BUILD_DOCKER_IMAGE_STEP_NAME
          );
          try {
            const result = await this.containerBuilderService.getStatus(
              build.containerStatusQuery
            );
            await this.handleContainerBuilderResult(
              build,
              stepBuildDocker,
              result
            );
          } catch (error) {
            await this.actionService.logInfo(stepBuildDocker, error);
            await this.actionService.complete(
              stepBuildDocker,
              EnumActionStepStatus.Failed
            );
          }
        }
      })
    );
  }

  private async getGenerateCodeStepStatus(
    buildId: string
  ): Promise<ActionStep | undefined> {
    const [generateStep] = await this.prisma.build
      .findUnique({
        where: {
          id: buildId
        }
      })
      .action()
      .steps({
        where: {
          name: GENERATE_STEP_NAME
        }
      });

    return generateStep;
  }

  async calcBuildStatus(buildId): Promise<EnumBuildStatus> {
    const build = await this.prisma.build.findUnique({
      where: {
        id: buildId
      },
      include: ACTION_INCLUDE
    });

    if (!build.action?.steps?.length) return EnumBuildStatus.Invalid;
    const steps = build.action.steps;

    if (steps.every(step => step.status === EnumActionStepStatus.Success))
      return EnumBuildStatus.Completed;

    if (steps.some(step => step.status === EnumActionStepStatus.Failed))
      return EnumBuildStatus.Failed;

    return EnumBuildStatus.Running;
  }

  async download(args: FindOneBuildArgs): Promise<NodeJS.ReadableStream> {
    const build = await this.findOne(args);
    const { id } = args.where;
    if (build === null) {
      throw new BuildNotFoundError(id);
    }

    const generatedCodeStep = await this.getGenerateCodeStepStatus(id);
    if (!generatedCodeStep) {
      throw new StepNotFoundError(GENERATE_STEP_NAME);
    }
    if (generatedCodeStep.status !== EnumActionStepStatus.Success) {
      throw new StepNotCompleteError(
        GENERATE_STEP_NAME,
        EnumActionStepStatus[generatedCodeStep.status]
      );
    }
    const filePath = getBuildZipFilePath(id);
    const disk = this.storageService.getDisk();
    const { exists } = await disk.exists(filePath);
    if (!exists) {
      throw new BuildResultNotFound(build.id);
    }
    return disk.getStream(filePath);
  }

  /**
   * Generates code for given build and saves it to storage
   * @param build build to generate code for
   */
  private async generate(build: Build): Promise<string> {
    return this.actionService.run(
      build.actionId,
      GENERATE_STEP_NAME,
      GENERATE_STEP_MESSAGE,
      async step => {
        const entities = await this.getOrderedEntities(build.id);
        const roles = await this.getAppRoles(build);
        const app = await this.appService.app({ where: { id: build.appId } });
        const [
          dataServiceGeneratorLogger,
          logPromises
        ] = this.createDataServiceLogger(build, step);

        const host = this.configService.get(HOST_VAR);

        const url = `${host}/${build.appId}`;

        const modules = await DataServiceGenerator.createDataService(
          entities,
          roles,
          {
            name: app.name,
            description: app.description,
            version: build.version,
            id: build.appId,
            url
          },
          dataServiceGeneratorLogger
        );

        await Promise.all(logPromises);

        dataServiceGeneratorLogger.destroy();

        await this.actionService.logInfo(step, ACTION_ZIP_LOG);
        if (process.env.AMP_PROJECTS_PATH) {
          const projectsPath = process.env.AMP_PROJECTS_PATH
          const appPath = path.join(projectsPath, build.app.name)
          let exists = true
          if (!fs.existsSync(appPath)) {
            fs.mkdirSync(appPath, { recursive: true })
            exists = false
          }
          const git: SimpleGit = simpleGit(appPath);
          if (!exists) {
            await git.init()
            for (const module of modules) {
              const filePath = path.join(appPath, module.path)
              try {
                fs.mkdirSync(path.dirname(filePath))
              } catch (err) {
              }
              fs.writeFileSync(
                filePath, module.code,
              )
              const add = await git.add(filePath)

            }
            await git.commit(`GEN: ${build?.commit.message}`)
          } else {
            try {
              await git.checkout('gen-code')

            } catch {
              await git.checkout(['-b', 'gen-code'])

            }
            for (const module of modules) {
              const filePath = path.join(appPath, module.path)
              fs.writeFileSync(filePath, module.code)
              await git.add(filePath)
            }

            await git.commit(`GEN: ${build?.commit.message}`)
            await git.checkout('master')
            await git.rebase(['gen-code'])
          }

        }

        const tarballURL = await this.save(build, modules);

        await this.saveToGitHub(build, modules);

        await this.actionService.logInfo(step, ACTION_JOB_DONE_LOG);

        return tarballURL;
      }
    );
  }

  /**
   * Builds Docker image for given build
   * Assuming build code was generated
   * @param build build to build docker image for
   */
  private async buildDockerImage(
    build: Build,
    tarballURL: string
  ): Promise<void> {
    return this.actionService.run(
      build.actionId,
      BUILD_DOCKER_IMAGE_STEP_NAME,
      BUILD_DOCKER_IMAGE_STEP_MESSAGE,
      async step => {
        await this.actionService.logInfo(
          step,
          BUILD_DOCKER_IMAGE_STEP_START_LOG
        );
        const tag = `${build.appId}:${build.id}`;
        const latestTag = `${build.appId}:latest`;
        const latestImageId = await this.containerBuilderService.createImageId(
          latestTag
        );
        const result = await this.containerBuilderService.build({
          tags: [tag, latestTag],
          cacheFrom: [latestImageId],
          url: tarballURL
        });
        await this.handleContainerBuilderResult(build, step, result);
      },
      true
    );
  }

  async handleContainerBuilderResult(
    build: Build,
    step: ActionStep,
    result: BuildResult
  ) {
    switch (result.status) {
      case ContainerBuildStatus.Completed:
        await this.actionService.logInfo(
          step,
          BUILD_DOCKER_IMAGE_STEP_FINISH_LOG,
          {
            images: result.images
          }
        );
        await this.actionService.complete(step, EnumActionStepStatus.Success);

        await this.prisma.build.update({
          where: { id: build.id },
          data: {
            images: {
              set: result.images
            }
          }
        });
        if (this.deploymentService.canDeploy) {
          await this.deploymentService.autoDeployToSandbox(build);
        }
        break;
      case ContainerBuildStatus.Failed:
        await this.actionService.logInfo(
          step,
          BUILD_DOCKER_IMAGE_STEP_FAILED_LOG
        );
        await this.actionService.complete(step, EnumActionStepStatus.Failed);
        break;
      default:
        await this.actionService.logInfo(
          step,
          BUILD_DOCKER_IMAGE_STEP_RUNNING_LOG
        );
        await this.prisma.build.update({
          where: { id: build.id },
          data: {
            containerStatusQuery: result.statusQuery,
            containerStatusUpdatedAt: new Date()
          }
        });
        break;
    }
  }

  async getDeployments(
    buildId: string,
    args: FindManyDeploymentArgs
  ): Promise<Deployment[]> {
    return this.deploymentService.findMany({
      ...args,
      where: { ...args?.where, build: { id: buildId } }
    });
  }

  private async getAppRoles(build: Build): Promise<AppRole[]> {
    return this.appRoleService.getAppRoles({
      where: {
        app: {
          id: build.appId
        }
      }
    });
  }

  private createDataServiceLogger(
    build: Build,
    step: ActionStep
  ): [winston.Logger, Array<Promise<void>>] {
    const transport = new winston.transports.Console();
    const logPromises: Array<Promise<void>> = [];
    transport.on('logged', info => {
      logPromises.push(this.createLog(step, info));
    });
    return [
      winston.createLogger({
        format: this.logger.format,
        transports: [transport],
        defaultMeta: {
          buildId: build.id
        }
      }),
      logPromises
    ];
  }

  /**
   * Saves given modules for given build as a Zip archive and tarball.
   * @param build the build to save the modules for
   * @param modules the modules to save
   * @returns created tarball URL
   */
  private async save(
    build: Build,
    modules: DataServiceGenerator.Module[]
  ): Promise<string> {
    const zipFilePath = getBuildZipFilePath(build.id);
    const tarFilePath = getBuildTarGzFilePath(build.id);
    const disk = this.storageService.getDisk();
    await Promise.all([
      createZipFileFromModules(modules).then(zip => disk.put(zipFilePath, zip)),
      createTarGzFileFromModules(modules).then(tar =>
        disk.put(tarFilePath, tar)
      )
    ]);
    return this.getFileURL(disk, tarFilePath);
  }

  private async saveToGitHub(
    build: Build,
    modules: DataServiceGenerator.Module[]
  ) {
    const app = build.app;
    const commit = build.commit;
    const truncateBuildId = build.id.slice(build.id.length - 8);

    const commitMessage =
      (commit.message &&
        `${commit.message} (Amplication build ${truncateBuildId})`) ||
      `Amplication build ${truncateBuildId}`;

    const host = this.configService.get(HOST_VAR);

    const url = `${host}/${build.appId}/builds/${build.id}`;

    if (app.githubSyncEnabled) {
      const [userName, repoName] = app.githubRepo.split('/');

      return this.actionService.run(
        build.actionId,
        PUSH_TO_GITHUB_STEP_NAME,
        PUSH_TO_GITHUB_STEP_MESSAGE,
        async step => {
          await this.actionService.logInfo(step, PUSH_TO_GITHUB_STEP_START_LOG);
          try {
            const prUrl = await this.githubService.createPullRequest(
              userName,
              repoName,
              modules,
              `amplication-build-${build.id}`,
              commitMessage,
              `Amplication build # ${build.id}.
Commit message: ${commit.message}

${url}
`,
              app.githubBranch,
              app.githubToken
            );

            await this.appService.reportSyncMessage(
              build.appId,
              'Sync Completed Successfully'
            );
            await this.actionService.logInfo(step, prUrl, { githubUrl: prUrl });
            await this.actionService.logInfo(
              step,
              PUSH_TO_GITHUB_STEP_FINISH_LOG
            );

            await this.actionService.complete(
              step,
              EnumActionStepStatus.Success
            );
          } catch (error) {
            await this.actionService.logInfo(
              step,
              PUSH_TO_GITHUB_STEP_FAILED_LOG
            );
            await this.actionService.logInfo(step, error);
            await this.actionService.complete(
              step,
              EnumActionStepStatus.Failed
            );
            await this.appService.reportSyncMessage(
              build.appId,
              `Error: ${error}`
            );
          }
        },
        true
      );
    }
  }

  /** @todo move */
  private getFileURL(disk: Storage, filePath: string) {
    try {
      return disk.getUrl(filePath);
    } catch (error) {
      if (error instanceof MethodNotSupported) {
        const root = this.localDiskService.getDisk().config.root;
        return path.join(root, filePath);
      }
      throw error;
    }
  }

  private async createLog(
    step: ActionStep,
    info: { message: string }
  ): Promise<void> {
    const { message, ...winstonMeta } = info;
    const level = WINSTON_LEVEL_TO_ACTION_LOG_LEVEL[info[LEVEL]];
    const meta = omit(winstonMeta, WINSTON_META_KEYS_TO_OMIT);

    await this.actionService.log(step, level, message, meta);
  }

  //this function must always return the entities in the same order to prevent unintended code changes
  private async getOrderedEntities(
    buildId: string
  ): Promise<DataServiceGenerator.Entity[]> {
    const entities = await this.entityService.getEntitiesByVersions({
      where: {
        builds: {
          some: {
            id: buildId
          }
        }
      },
      include: ENTITIES_INCLUDE
    });
    return orderBy(
      entities,
      entity => entity.createdAt
    ) as DataServiceGenerator.Entity[];
  }
}
