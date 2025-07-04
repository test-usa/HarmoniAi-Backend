import { JwtPayload } from "jsonwebtoken";
import config from "../../config";
import ApiError from "../../errors/ApiError";
import { TUser } from "./user.interface";
import { User } from "./user.model";
import bcrypt from "bcrypt";
import httpStatus from "http-status";
import { sendFileToCloudinary } from "../../utils/sendFileToCloudinary";
import { sendVerificationEmail } from "../../utils/sendVerificationEmail";
import mongoose from 'mongoose';
import QueryBuilder from "../../builder/QueryBuilder";
import { USER_SEARCHABLE_FIELDS } from "./user.constants";
import e from "cors";

export const generateVerificationCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString(); // Generates a 6-digit verification code 
}


export const updateUserProfileService = async (
  userId: string,
  updatePayload: Partial<any>
) => {
  const updatedUser = await User.findByIdAndUpdate(
    userId,
    { $set: updatePayload },
    { new: true, runValidators: true }
  ).select("-password -verificationCode -verificationCodeExpiresAt");

  return updatedUser;
};

export const updateTokenFromUser = async (
  userId: string,
  tokensToDeduct: any
) => {
  // Deduct tokens from user
  const updatedUser = await User.findByIdAndUpdate(
    userId,
    { $inc: { token: -tokensToDeduct } },
    { new: true }
  );

  if (!updatedUser) {
    throw new ApiError(httpStatus.NOT_FOUND, "User not found while deducting token.");
  }
  return updatedUser
};



const getAllUsersFromDB = async (query: any) => {
  let baseFilter: any = {};
  if (query.isVerified !== undefined) {
    baseFilter.isVerified = query.isVerified || true

  }

  if (query.isDeleted !== undefined) {
    baseFilter.isDeleted = query.isDeleted || false;
    baseFilter.role = { $ne: "admin"}
  }
  const service_query = new QueryBuilder(User.find(baseFilter), query)
    .search(USER_SEARCHABLE_FIELDS)
    .filter()
    .sort()
    .paginate()
    .fields();

  const result = await service_query.modelQuery;
  const meta = await service_query.countTotal();
  return {
    result,
    meta,
  };
};



const getMeFromDB = async (user: JwtPayload) => {
  const existingUser = await User.findOne({
    _id: user.userId,
    isDeleted: false,
  });
  if (!existingUser)
    throw new ApiError(httpStatus.FORBIDDEN, "Failed to Fetch user");

  return existingUser;
};



const createAUserIntoDB = async (payload: TUser) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const existingUser = await User.findOne({ email: payload.email }).session(session);
    if (existingUser) {
      throw new ApiError(httpStatus.CONFLICT, "User with this email already exists");
    }
    if (!payload.password) {
      throw new ApiError(httpStatus.NOT_FOUND, "Password must be included")
    }

    const hashedPassword = await bcrypt.hash(payload.password, Number(config.bcrypt_salt_rounds));
    const verificationCode = generateVerificationCode();
    const verificationCodeExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const lastVerificationSentAt = new Date();

    // Prepare user data
    const userData = {
      ...payload,
      password: hashedPassword,
      verificationCode,
      verificationCodeExpiresAt,
      lastVerificationSentAt,
      isVerified: false,
    };

    // Try to create the user in transaction
    const user: any = await User.create([userData], { session });

    // Send email after DB is guaranteed to be successful
    await sendVerificationEmail(payload.email, verificationCode);

    // Commit transaction
    await session.commitTransaction();
    session.endSession();

    return {
      name: user[0].name,
      image: user[0].image,
      email: user[0].email,
      role: user[0].role,
      token: user[0].token,
      theme: user[0].theme,
      language: user[0].language,
      isVerified: user[0].isVerified,
      isVerificationExpired: user[0].verificationCodeExpiresAt < new Date(),
    };
  } catch (error) {
    await session.abortTransaction();
    session.endSession();

    // Optional: Log or handle retry here
    throw error
  }
};


const uploadImageIntoDB = async (userData: any, file: any) => {
  const user = await User.findOne({
    _id: userData.userId,
    isDeleted: false,
  });
  if (!user) throw new ApiError(httpStatus.NOT_FOUND, "User not found");
  if (!file)
    throw new ApiError(httpStatus.BAD_REQUEST, "Please provide an image first");

  const imageName = `${user.name}-${user.role}-${Date.now()}`;
  const cloudinary_response = (await sendFileToCloudinary(
    imageName,
    file?.path,
    "image"
  )) as { secure_url: string };

  const result = await User.findOneAndUpdate(
    { _id: userData.userId },
    { image: cloudinary_response.secure_url },
    { new: true, runValidators: true }
  );
  return result;
};

const changeUserLanguage = async (user: any, language: string) => {
  const existingUser = await await User.findOne({
    _id: user.userId,
    isDeleted: false,
  });
  if (!existingUser)
    throw new ApiError(httpStatus.NOT_FOUND, "User not found!");
  return await User.findByIdAndUpdate(
    user.userId,
    { language },
    { new: true, runValidators: true }
  );
};


const changeUserTheme = async (user: any, theme: string) => {
  const existingUser = await User.findOne({
    _id: user.userId,
    isDeleted: false,
  });
  if (!existingUser)
    throw new ApiError(httpStatus.NOT_FOUND, "User not found!");
  return await User.findByIdAndUpdate(
    user.userId,
    { theme },
    { new: true, runValidators: true }
  );
};


const toggleUserDeleteInDB = async (id: string, deleted: boolean) => {
  const existingUser = await User.findById(id);
  if (!existingUser)
    throw new ApiError(httpStatus.NOT_FOUND, "User not found!");



  return await User.findByIdAndUpdate(
    id,
    { isDeleted: deleted },
    { new: true, runValidators: true }
  );
};


const getSingleUser = async (id: string) => {
  const existingUser = await User.findById(id).select("-password -verificationCode -verificationCodeExpiresAt -lastVerificationSentAt ");
  if (!existingUser)
    throw new ApiError(httpStatus.NOT_FOUND, "User not found!");


  return existingUser;


};

export const UserServices = {
  getMeFromDB,
  getAllUsersFromDB,
  getSingleUser,
  createAUserIntoDB,
  changeUserLanguage,
  changeUserTheme,
  uploadImageIntoDB,
  toggleUserDeleteInDB,
};
